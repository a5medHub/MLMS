import { env } from "../config/env";

type EstimateDueDateInput = {
  title: string;
  author: string;
  isbn?: string | null;
};

type DueDateEstimate = {
  dueAt: Date;
  days: number;
  source: "google_books" | "openlibrary" | "fallback";
  pageCount: number | null;
};

const timeoutMs = 9000;
const minimumDays = 14;
const maximumDays = 45;
const fallbackDays = 30;

const normalize = (value: string): string => {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
};

const fetchJson = async <T>(url: string): Promise<T | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    clearTimeout(timer);
  }
};

const estimatePagesPerDay = (category: string | null): number => {
  if (!category) {
    return 35;
  }
  const value = normalize(category);
  if (value.includes("children") || value.includes("young adult")) {
    return 50;
  }
  if (
    value.includes("science") ||
    value.includes("engineering") ||
    value.includes("technology") ||
    value.includes("computer")
  ) {
    return 25;
  }
  if (value.includes("fantasy") || value.includes("historical") || value.includes("classic")) {
    return 30;
  }
  return 35;
};

const clampDays = (days: number): number => {
  return Math.max(minimumDays, Math.min(maximumDays, Math.round(days)));
};

const buildDueDate = (days: number): Date => {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
};

const findGooglePageCount = async (input: EstimateDueDateInput): Promise<{ pageCount: number; category: string | null } | null> => {
  const titleNorm = normalize(input.title);
  const authorNorm = normalize(input.author);
  const query = input.isbn ? `isbn:${input.isbn}` : `intitle:${input.title}+inauthor:${input.author}`;

  const params = new URLSearchParams({
    q: query,
    maxResults: "10",
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
        pageCount?: number;
        categories?: string[];
      };
    }>;
  }>(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`);

  const items = payload?.items ?? [];
  let best: { score: number; pageCount: number; category: string | null } | null = null;

  for (const item of items) {
    const volume = item.volumeInfo;
    if (!volume?.pageCount || volume.pageCount < 30) {
      continue;
    }
    const candidateTitle = normalize(volume.title ?? "");
    const candidateAuthor = normalize(volume.authors?.[0] ?? "");
    let score = 0;
    if (candidateTitle === titleNorm) {
      score += 30;
    } else if (candidateTitle && titleNorm && (candidateTitle.includes(titleNorm) || titleNorm.includes(candidateTitle))) {
      score += 15;
    }

    if (candidateAuthor === authorNorm) {
      score += 20;
    } else if (candidateAuthor && authorNorm && (candidateAuthor.includes(authorNorm) || authorNorm.includes(candidateAuthor))) {
      score += 10;
    }

    score += Math.min(15, Math.floor(volume.pageCount / 40));

    const category = volume.categories?.[0] ?? null;
    if (!best || score > best.score) {
      best = { score, pageCount: volume.pageCount, category };
    }
  }

  if (!best) {
    return null;
  }
  return { pageCount: best.pageCount, category: best.category };
};

const findOpenLibraryPageCount = async (input: EstimateDueDateInput): Promise<number | null> => {
  const query = `${input.title} ${input.author}`.trim();
  const params = new URLSearchParams({
    q: query,
    limit: "5"
  });

  const payload = await fetchJson<{
    docs?: Array<{
      number_of_pages_median?: number;
      title?: string;
      author_name?: string[];
    }>;
  }>(`https://openlibrary.org/search.json?${params.toString()}`);

  const docs = payload?.docs ?? [];
  const titleNorm = normalize(input.title);
  const authorNorm = normalize(input.author);
  let best: { score: number; pages: number } | null = null;

  for (const doc of docs) {
    const pages = doc.number_of_pages_median;
    if (!pages || pages < 30) {
      continue;
    }
    const candidateTitle = normalize(doc.title ?? "");
    const candidateAuthor = normalize(doc.author_name?.[0] ?? "");
    let score = 0;
    if (candidateTitle === titleNorm) {
      score += 30;
    } else if (candidateTitle && titleNorm && (candidateTitle.includes(titleNorm) || titleNorm.includes(candidateTitle))) {
      score += 15;
    }

    if (candidateAuthor === authorNorm) {
      score += 20;
    } else if (candidateAuthor && authorNorm && (candidateAuthor.includes(authorNorm) || authorNorm.includes(candidateAuthor))) {
      score += 10;
    }

    if (!best || score > best.score) {
      best = { score, pages };
    }
  }

  return best?.pages ?? null;
};

export const estimateLoanDueDate = async (input: EstimateDueDateInput): Promise<DueDateEstimate> => {
  const google = await findGooglePageCount(input);
  if (google) {
    const pagesPerDay = estimatePagesPerDay(google.category);
    const days = clampDays(google.pageCount / pagesPerDay);
    return {
      dueAt: buildDueDate(days),
      days,
      source: "google_books",
      pageCount: google.pageCount
    };
  }

  const openLibraryPages = await findOpenLibraryPageCount(input);
  if (openLibraryPages) {
    const days = clampDays(openLibraryPages / 35);
    return {
      dueAt: buildDueDate(days),
      days,
      source: "openlibrary",
      pageCount: openLibraryPages
    };
  }

  return {
    dueAt: buildDueDate(fallbackDays),
    days: fallbackDays,
    source: "fallback",
    pageCount: null
  };
};
