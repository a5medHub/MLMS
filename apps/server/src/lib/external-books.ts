import { env } from "../config/env";
import { prisma } from "../db/prisma";

type ExternalSource = "openlibrary" | "google";
type SearchProvider = ExternalSource | "auto";

export type ExternalBookCandidate = {
  title: string;
  author: string;
  isbn: string | null;
  genre: string | null;
  publishedYear: number | null;
  description: string | null;
  coverUrl: string | null;
  source: ExternalSource;
};

type SearchExternalBooksResult = {
  books: ExternalBookCandidate[];
  sourceUsed: ExternalSource | null;
  fallbackUsed: boolean;
};

const requestTimeoutMs = 9000;

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeIsbn = (input: string): string | null => {
  const cleaned = input.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (cleaned.length === 10 || cleaned.length === 13) {
    return cleaned;
  }
  return null;
};

const parsePublishedYear = (raw: unknown): number | null => {
  if (typeof raw === "number" && raw >= 0 && raw <= 2100) {
    return Math.floor(raw);
  }
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.match(/\b(1[0-9]{3}|20[0-9]{2}|2100)\b/);
  return match ? Number(match[1]) : null;
};

const fetchJson = async <T>(url: string): Promise<T | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const searchOpenLibrary = async (query: string, limit: number): Promise<ExternalBookCandidate[]> => {
  const params = new URLSearchParams({
    q: query,
    limit: String(Math.min(limit, 100))
  });
  const url = `https://openlibrary.org/search.json?${params.toString()}`;
  const payload = await fetchJson<{
    docs?: Array<{
      title?: string;
      author_name?: string[];
      isbn?: string[];
      subject?: string[];
      first_publish_year?: number;
      cover_i?: number;
    }>;
  }>(url);

  const docs = payload?.docs ?? [];
  const output: ExternalBookCandidate[] = [];

  for (const doc of docs) {
      const title = normalizeText(doc.title);
      const author = normalizeText(doc.author_name?.[0]) ?? "Unknown Author";
      if (!title) {
        continue;
      }

      const firstIsbn = doc.isbn?.map((value) => normalizeIsbn(value)).find((value) => !!value) ?? null;
      const genre = normalizeText(doc.subject?.[0]) ?? null;
      const coverUrl = typeof doc.cover_i === "number" ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null;

      output.push({
        title,
        author,
        isbn: firstIsbn,
        genre,
        publishedYear: parsePublishedYear(doc.first_publish_year),
        description: null,
        coverUrl,
        source: "openlibrary"
      });
  }

  return output;
};

const searchGoogleBooks = async (query: string, limit: number): Promise<ExternalBookCandidate[]> => {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(Math.min(limit, 40)),
    printType: "books",
    orderBy: "relevance"
  });
  if (env.GOOGLE_BOOKS_API_KEY) {
    params.set("key", env.GOOGLE_BOOKS_API_KEY);
  }

  const payload = await fetchJson<{
    items?: Array<{
      volumeInfo?: {
        title?: string;
        authors?: string[];
        categories?: string[];
        description?: string;
        publishedDate?: string;
        industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
        imageLinks?: {
          thumbnail?: string;
          smallThumbnail?: string;
        };
      };
    }>;
  }>(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`);

  const items = payload?.items ?? [];
  const output: ExternalBookCandidate[] = [];

  for (const item of items) {
      const info = item.volumeInfo;
      const title = normalizeText(info?.title);
      if (!title) {
        continue;
      }

      const author = normalizeText(info?.authors?.[0]) ?? "Unknown Author";
      const identifiers = info?.industryIdentifiers ?? [];
      const preferredIsbn =
        identifiers
          .map((identifier) => normalizeIsbn(identifier.identifier ?? ""))
          .find((value) => !!value) ?? null;

      output.push({
        title,
        author,
        isbn: preferredIsbn,
        genre: normalizeText(info?.categories?.[0]) ?? null,
        publishedYear: parsePublishedYear(info?.publishedDate),
        description: normalizeText(info?.description),
        coverUrl: normalizeText(info?.imageLinks?.thumbnail) ?? normalizeText(info?.imageLinks?.smallThumbnail),
        source: "google"
      });
  }

  return output;
};

const dedupeCandidates = (candidates: ExternalBookCandidate[]): ExternalBookCandidate[] => {
  const seen = new Set<string>();
  const output: ExternalBookCandidate[] = [];

  for (const candidate of candidates) {
    const key = candidate.isbn ?? `${candidate.title.toLowerCase()}|${candidate.author.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(candidate);
  }
  return output;
};

export const searchExternalBooks = async (
  query: string,
  limit: number,
  provider: SearchProvider = "auto"
): Promise<SearchExternalBooksResult> => {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return { books: [], sourceUsed: null, fallbackUsed: false };
  }

  if (provider === "openlibrary") {
    const books = dedupeCandidates(await searchOpenLibrary(normalizedQuery, limit)).slice(0, limit);
    return { books, sourceUsed: books.length > 0 ? "openlibrary" : null, fallbackUsed: false };
  }

  if (provider === "google") {
    const books = dedupeCandidates(await searchGoogleBooks(normalizedQuery, limit)).slice(0, limit);
    return { books, sourceUsed: books.length > 0 ? "google" : null, fallbackUsed: false };
  }

  const openLibraryBooks = dedupeCandidates(await searchOpenLibrary(normalizedQuery, limit));
  if (openLibraryBooks.length > 0) {
    return {
      books: openLibraryBooks.slice(0, limit),
      sourceUsed: "openlibrary",
      fallbackUsed: false
    };
  }

  const googleBooks = dedupeCandidates(await searchGoogleBooks(normalizedQuery, limit));
  return {
    books: googleBooks.slice(0, limit),
    sourceUsed: googleBooks.length > 0 ? "google" : null,
    fallbackUsed: true
  };
};

export const persistExternalBooks = async (
  candidates: ExternalBookCandidate[]
): Promise<{ books: Array<Awaited<ReturnType<typeof prisma.book.create>>>; createdCount: number; reusedCount: number }> => {
  const books: Array<Awaited<ReturnType<typeof prisma.book.create>>> = [];
  let createdCount = 0;
  let reusedCount = 0;

  for (const candidate of dedupeCandidates(candidates)) {
    const existingByIsbn = candidate.isbn
      ? await prisma.book.findUnique({
          where: { isbn: candidate.isbn }
        })
      : null;

    if (existingByIsbn) {
      books.push(existingByIsbn);
      reusedCount += 1;
      continue;
    }

    const existingByTitleAuthor = await prisma.book.findFirst({
      where: {
        title: { equals: candidate.title, mode: "insensitive" },
        author: { equals: candidate.author, mode: "insensitive" }
      }
    });

    if (existingByTitleAuthor) {
      books.push(existingByTitleAuthor);
      reusedCount += 1;
      continue;
    }

    try {
      const created = await prisma.book.create({
        data: {
          title: candidate.title,
          author: candidate.author,
          isbn: candidate.isbn,
          genre: candidate.genre,
          publishedYear: candidate.publishedYear,
          description: candidate.description,
          coverUrl: candidate.coverUrl
        }
      });
      books.push(created);
      createdCount += 1;
    } catch (error) {
      const isUniqueViolation =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "P2002";
      if (isUniqueViolation && candidate.isbn) {
        const existing = await prisma.book.findUnique({
          where: { isbn: candidate.isbn }
        });
        if (existing) {
          books.push(existing);
          reusedCount += 1;
          continue;
        }
      }
      throw error;
    }
  }

  return { books, createdCount, reusedCount };
};
