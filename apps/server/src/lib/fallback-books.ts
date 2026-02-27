type FallbackBook = {
  id: string;
  title: string;
  author: string;
  isbn: string | null;
  genre: string | null;
  publishedYear: number | null;
  description: string | null;
  coverUrl: string | null;
  averageRating: number | null;
  ratingsCount: number | null;
  aiMetadata: boolean;
  available: boolean;
  requestPending: boolean;
  createdAt: string;
  updatedAt: string;
};

const nowIso = new Date().toISOString();

export const FALLBACK_BOOKS: FallbackBook[] = [
  {
    id: "fallback-1984",
    title: "1984",
    author: "George Orwell",
    isbn: null,
    genre: "Dystopian",
    publishedYear: 1949,
    description: "A classic about surveillance, control, and resistance.",
    coverUrl: null,
    averageRating: 4.6,
    ratingsCount: 1200,
    aiMetadata: false,
    available: true,
    requestPending: false,
    createdAt: nowIso,
    updatedAt: nowIso
  },
  {
    id: "fallback-pride",
    title: "Pride and Prejudice",
    author: "Jane Austen",
    isbn: null,
    genre: "Classic",
    publishedYear: 1813,
    description: "A timeless novel of manners, family, and social expectations.",
    coverUrl: null,
    averageRating: 4.5,
    ratingsCount: 980,
    aiMetadata: false,
    available: true,
    requestPending: false,
    createdAt: nowIso,
    updatedAt: nowIso
  },
  {
    id: "fallback-mobydick",
    title: "Moby-Dick",
    author: "Herman Melville",
    isbn: null,
    genre: "Adventure",
    publishedYear: 1851,
    description: "Captain Ahab's obsessive quest across the sea.",
    coverUrl: null,
    averageRating: 4.1,
    ratingsCount: 760,
    aiMetadata: false,
    available: true,
    requestPending: false,
    createdAt: nowIso,
    updatedAt: nowIso
  },
  {
    id: "fallback-warpeace",
    title: "War and Peace",
    author: "Leo Tolstoy",
    isbn: null,
    genre: "Historical Fiction",
    publishedYear: 1869,
    description: "Epic narrative of families, war, and society in Imperial Russia.",
    coverUrl: null,
    averageRating: 4.4,
    ratingsCount: 640,
    aiMetadata: false,
    available: true,
    requestPending: false,
    createdAt: nowIso,
    updatedAt: nowIso
  },
  {
    id: "fallback-mockingbird",
    title: "To Kill a Mockingbird",
    author: "Harper Lee",
    isbn: null,
    genre: "Literary Fiction",
    publishedYear: 1960,
    description: "A coming-of-age story confronting justice and prejudice.",
    coverUrl: null,
    averageRating: 4.7,
    ratingsCount: 1400,
    aiMetadata: false,
    available: true,
    requestPending: false,
    createdAt: nowIso,
    updatedAt: nowIso
  },
  {
    id: "fallback-gatsby",
    title: "The Great Gatsby",
    author: "F. Scott Fitzgerald",
    isbn: null,
    genre: "Classic",
    publishedYear: 1925,
    description: "A portrait of ambition and illusion in the Jazz Age.",
    coverUrl: null,
    averageRating: 4.3,
    ratingsCount: 910,
    aiMetadata: false,
    available: true,
    requestPending: false,
    createdAt: nowIso,
    updatedAt: nowIso
  }
];
