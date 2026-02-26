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

type LocalBook = Awaited<ReturnType<typeof prisma.book.create>>;

type MetadataPatch = {
  coverUrl?: string;
  description?: string;
  genre?: string;
  publishedYear?: number;
  isbn?: string;
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

const normalizeForCompare = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
};

const buildMetadataPatch = (existing: LocalBook, candidate: ExternalBookCandidate): MetadataPatch => {
  const patch: MetadataPatch = {};
  if (!existing.coverUrl && candidate.coverUrl) {
    patch.coverUrl = candidate.coverUrl;
  }
  if (!existing.description && candidate.description) {
    patch.description = candidate.description;
  }
  if (!existing.genre && candidate.genre) {
    patch.genre = candidate.genre;
  }
  if (!existing.publishedYear && candidate.publishedYear) {
    patch.publishedYear = candidate.publishedYear;
  }
  if (!existing.isbn && candidate.isbn) {
    patch.isbn = candidate.isbn;
  }
  return patch;
};

const needsMetadataEnrichment = (book: LocalBook): boolean => {
  return !book.coverUrl || !book.description || !book.genre || !book.publishedYear || !book.isbn;
};

const candidateScore = (book: LocalBook, candidate: ExternalBookCandidate): number => {
  let score = 0;
  const titleA = normalizeForCompare(book.title);
  const titleB = normalizeForCompare(candidate.title);
  const authorA = normalizeForCompare(book.author);
  const authorB = normalizeForCompare(candidate.author);

  if (book.isbn && candidate.isbn) {
    if (book.isbn === candidate.isbn) {
      score += 100;
    } else {
      score -= 30;
    }
  }

  if (titleA === titleB) {
    score += 40;
  } else if (titleA && titleB && (titleA.includes(titleB) || titleB.includes(titleA))) {
    score += 20;
  }

  if (authorA === authorB) {
    score += 25;
  } else if (authorA && authorB && (authorA.includes(authorB) || authorB.includes(authorA))) {
    score += 10;
  }

  const patch = buildMetadataPatch(book, candidate);
  score += Object.keys(patch).length * 6;
  return score;
};

const queryByProvider = async (
  query: string,
  limit: number,
  provider: SearchProvider
): Promise<ExternalBookCandidate[]> => {
  if (provider === "openlibrary") {
    return dedupeCandidates(await searchOpenLibrary(query, limit));
  }
  if (provider === "google") {
    return dedupeCandidates(await searchGoogleBooks(query, limit));
  }

  // For metadata enrichment quality, prefer Google first then Open Library fallback.
  const google = await searchGoogleBooks(query, limit);
  if (google.length > 0) {
    return dedupeCandidates(google);
  }
  return dedupeCandidates(await searchOpenLibrary(query, limit));
};

const findBestCandidateForBook = async (
  book: LocalBook,
  provider: SearchProvider
): Promise<ExternalBookCandidate | null> => {
  const attempts: string[] = [];
  if (book.isbn) {
    attempts.push(`isbn:${book.isbn}`);
  }
  attempts.push(`${book.title} ${book.author}`);
  attempts.push(book.title);

  let best: ExternalBookCandidate | null = null;
  let bestScore = -Infinity;

  for (const query of attempts) {
    const candidates = await queryByProvider(query, 10, provider);
    for (const candidate of candidates) {
      const score = candidateScore(book, candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best && bestScore >= 25) {
      return best;
    }
  }

  if (best && bestScore >= 18) {
    return best;
  }
  return null;
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
  const books: LocalBook[] = [];
  let createdCount = 0;
  let reusedCount = 0;

  const enrichExistingBook = async (existing: LocalBook, candidate: ExternalBookCandidate) => {
    const patch = buildMetadataPatch(existing, candidate);
    if (Object.keys(patch).length === 0) {
      return existing;
    }

    return prisma.book.update({
      where: { id: existing.id },
      data: patch
    });
  };

  for (const candidate of dedupeCandidates(candidates)) {
    const existingByIsbn = candidate.isbn
      ? await prisma.book.findUnique({
          where: { isbn: candidate.isbn }
        })
      : null;

    if (existingByIsbn) {
      const enriched = await enrichExistingBook(existingByIsbn, candidate);
      books.push(enriched);
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
      const enriched = await enrichExistingBook(existingByTitleAuthor, candidate);
      books.push(enriched);
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

export const enrichLibraryMetadata = async (options: {
  limit: number;
  provider: SearchProvider;
  onlyMissing: boolean;
}): Promise<{
  processed: number;
  updatedCount: number;
  skippedCount: number;
  noMatchCount: number;
  failedCount: number;
}> => {
  const books = await prisma.book.findMany({
    where: options.onlyMissing
      ? {
          OR: [
            { coverUrl: null },
            { description: null },
            { genre: null },
            { publishedYear: null },
            { isbn: null }
          ]
        }
      : {},
    orderBy: [{ updatedAt: "asc" }],
    take: options.limit
  });

  let updatedCount = 0;
  let skippedCount = 0;
  let noMatchCount = 0;
  let failedCount = 0;

  for (const book of books) {
    try {
      if (options.onlyMissing && !needsMetadataEnrichment(book)) {
        skippedCount += 1;
        continue;
      }

      const candidate = await findBestCandidateForBook(book, options.provider);
      if (!candidate) {
        noMatchCount += 1;
        continue;
      }

      const patch = buildMetadataPatch(book, candidate);
      if (Object.keys(patch).length === 0) {
        skippedCount += 1;
        continue;
      }

      await prisma.book.update({
        where: { id: book.id },
        data: patch
      });
      updatedCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  return {
    processed: books.length,
    updatedCount,
    skippedCount,
    noMatchCount,
    failedCount
  };
};
