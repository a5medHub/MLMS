export type Role = "ADMIN" | "MEMBER";

export type User = {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt?: string;
};

export type Book = {
  id: string;
  title: string;
  author: string;
  isbn: string | null;
  genre: string | null;
  publishedYear: number | null;
  description: string | null;
  coverUrl: string | null;
  available: boolean;
  createdAt: string;
};

export type Loan = {
  id: string;
  bookId: string;
  userId: string;
  checkedOutAt: string;
  dueAt: string | null;
  returnedAt: string | null;
  book: Book;
  user: Pick<User, "id" | "name" | "email">;
};
