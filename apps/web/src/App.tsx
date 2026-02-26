import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getApiBaseUrl, requestJson } from "./lib/api-client";
import type { Book, Loan, Role, User } from "./types";

type AuthResponse = {
  accessToken: string;
  user: User;
};

type BooksResponse = {
  data: Book[];
  pageInfo: {
    hasNextPage: boolean;
    nextCursor: string | null;
  };
};

const emptyBookForm = {
  title: "",
  author: "",
  isbn: "",
  genre: "",
  publishedYear: "",
  description: "",
  coverUrl: ""
};

const parseApiError = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something unexpected happened.";
};

const toNullableText = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const LoginScreen = ({
  onGoogleCredential,
  busy,
  message
}: {
  onGoogleCredential: (credential: string) => Promise<void>;
  busy: boolean;
  message: string;
}) => {
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

  useEffect(() => {
    if (!googleClientId) {
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const target = document.getElementById("google-signin");
      if (!target || !window.google?.accounts?.id) {
        return;
      }

      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: ({ credential }) => {
          void onGoogleCredential(credential);
        }
      });
      window.google.accounts.id.renderButton(target, {
        type: "standard",
        theme: "outline",
        text: "signin_with",
        size: "large",
        shape: "pill",
        width: 280
      });
    };
    document.body.appendChild(script);

    return () => {
      script.remove();
    };
  }, [googleClientId, onGoogleCredential]);

  return (
    <main className="auth-shell" aria-labelledby="auth-heading">
      <section className="auth-card">
        <p className="eyebrow">Mini Library Management System</p>
        <h1 id="auth-heading">Sign in to manage your library</h1>
        <p className="muted">
          Mobile-first, role-based, and accessible by default. Use Google SSO to continue.
        </p>
        <div id="google-signin" aria-label="Google Sign In button" />
        {!googleClientId && (
          <p className="notice" role="alert">
            Missing <code>VITE_GOOGLE_CLIENT_ID</code>. Add it to your web environment variables.
          </p>
        )}
        {busy && <p className="muted">Signing in...</p>}
        <p className="notice" aria-live="polite">
          {message}
        </p>
      </section>
    </main>
  );
};

const App = () => {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() => localStorage.getItem("mlms_access_token"));
  const [message, setMessage] = useState("Welcome.");

  const [books, setBooks] = useState<Book[]>([]);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [booksLoading, setBooksLoading] = useState(false);

  const [loans, setLoans] = useState<Loan[]>([]);
  const [loansLoading, setLoansLoading] = useState(false);
  const [recommendations, setRecommendations] = useState<Book[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);

  const [query, setQuery] = useState("");
  const [availableFilter, setAvailableFilter] = useState("all");
  const [showBookEditor, setShowBookEditor] = useState(false);
  const [editingBookId, setEditingBookId] = useState<string | null>(null);
  const [bookForm, setBookForm] = useState(emptyBookForm);
  const [submittingBook, setSubmittingBook] = useState(false);

  const tokenRef = useRef<string | null>(accessToken);

  useEffect(() => {
    tokenRef.current = accessToken;
    if (accessToken) {
      localStorage.setItem("mlms_access_token", accessToken);
    } else {
      localStorage.removeItem("mlms_access_token");
    }
  }, [accessToken]);

  const refreshAccessToken = useCallback(async (): Promise<string> => {
    const result = await requestJson<{ accessToken: string }>("/auth/refresh", {
      method: "POST"
    });
    setAccessToken(result.accessToken);
    return result.accessToken;
  }, []);

  const authRequest = useCallback(
    async <TResponse,>(path: string, options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {}) => {
      try {
        return await requestJson<TResponse>(path, {
          ...options,
          accessToken: tokenRef.current
        });
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 401) {
          const refreshedToken = await refreshAccessToken();
          return requestJson<TResponse>(path, {
            ...options,
            accessToken: refreshedToken
          });
        }
        throw error;
      }
    },
    [refreshAccessToken]
  );

  const loadBooks = useCallback(
    async (cursor?: string | null) => {
      setBooksLoading(true);
      try {
        const params = new URLSearchParams();
        if (query.trim()) {
          params.set("q", query.trim());
        }
        if (availableFilter !== "all") {
          params.set("available", availableFilter === "available" ? "true" : "false");
        }
        params.set("limit", "12");
        if (cursor) {
          params.set("cursor", cursor);
        }

        const result = await authRequest<BooksResponse>(`/books?${params.toString()}`);
        setBooks((previous) => (cursor ? [...previous, ...result.data] : result.data));
        setHasNextPage(result.pageInfo.hasNextPage);
        setNextCursor(result.pageInfo.nextCursor);
      } catch (error) {
        setMessage(parseApiError(error));
      } finally {
        setBooksLoading(false);
      }
    },
    [authRequest, availableFilter, query]
  );

  const loadLoans = useCallback(async () => {
    setLoansLoading(true);
    try {
      const result = await authRequest<{ data: Loan[] }>("/loans");
      setLoans(result.data);
    } catch (error) {
      setMessage(parseApiError(error));
    } finally {
      setLoansLoading(false);
    }
  }, [authRequest]);

  const loadRecommendations = useCallback(async () => {
    setRecommendationsLoading(true);
    try {
      const result = await authRequest<{ data: Book[] }>("/ai/recommendations", {
        method: "POST",
        body: { limit: 5 }
      });
      setRecommendations(result.data);
    } catch (error) {
      setMessage(parseApiError(error));
    } finally {
      setRecommendationsLoading(false);
    }
  }, [authRequest]);

  const loadUsers = useCallback(async () => {
    if (user?.role !== "ADMIN") {
      return;
    }
    setAdminLoading(true);
    try {
      const result = await authRequest<{ data: User[] }>("/users");
      setUsers(result.data);
    } catch (error) {
      setMessage(parseApiError(error));
    } finally {
      setAdminLoading(false);
    }
  }, [authRequest, user?.role]);

  const bootAuth = useCallback(async () => {
    try {
      let token = tokenRef.current;
      if (!token) {
        token = await refreshAccessToken();
      }
      const me = await requestJson<{ user: User }>("/auth/me", { accessToken: token });
      setUser(me.user);
      setAccessToken(token);
      setMessage(`Welcome back, ${me.user.name}.`);
    } catch {
      setUser(null);
      setAccessToken(null);
      setMessage("Please sign in to continue.");
    } finally {
      setBooting(false);
    }
  }, [refreshAccessToken]);

  useEffect(() => {
    void bootAuth();
  }, [bootAuth]);

  useEffect(() => {
    if (!user) {
      return;
    }
    void Promise.all([loadBooks(), loadLoans(), loadRecommendations(), loadUsers()]);
  }, [loadBooks, loadLoans, loadRecommendations, loadUsers, user]);

  const loginWithGoogleCredential = useCallback(async (credential: string) => {
    try {
      setMessage("Signing in...");
      const result = await requestJson<AuthResponse>("/auth/google", {
        method: "POST",
        body: { credential }
      });
      setAccessToken(result.accessToken);
      setUser(result.user);
      setMessage(`Signed in as ${result.user.name}.`);
    } catch (error) {
      setMessage(parseApiError(error));
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await requestJson<{ success: boolean }>("/auth/logout", { method: "POST" });
    } catch {
      // no-op for failed logout request
    } finally {
      setUser(null);
      setAccessToken(null);
      setBooks([]);
      setLoans([]);
      setUsers([]);
      setMessage("Signed out.");
    }
  }, []);

  const activeLoans = useMemo(() => loans.filter((loan) => !loan.returnedAt), [loans]);
  const canManageBooks = user?.role === "ADMIN";

  const resetBookForm = () => {
    setBookForm(emptyBookForm);
    setEditingBookId(null);
    setShowBookEditor(false);
  };

  const submitBook = async () => {
    try {
      setSubmittingBook(true);
      const payload = {
        title: bookForm.title,
        author: bookForm.author,
        isbn: toNullableText(bookForm.isbn),
        genre: toNullableText(bookForm.genre),
        publishedYear: bookForm.publishedYear ? Number(bookForm.publishedYear) : null,
        description: toNullableText(bookForm.description),
        coverUrl: toNullableText(bookForm.coverUrl)
      };

      if (editingBookId) {
        await authRequest(`/books/${editingBookId}`, { method: "PATCH", body: payload });
        setMessage("Book updated.");
      } else {
        await authRequest("/books", { method: "POST", body: payload });
        setMessage("Book created.");
      }
      resetBookForm();
      await loadBooks();
    } catch (error) {
      setMessage(parseApiError(error));
    } finally {
      setSubmittingBook(false);
    }
  };

  const editBook = (book: Book) => {
    setEditingBookId(book.id);
    setBookForm({
      title: book.title,
      author: book.author,
      isbn: book.isbn ?? "",
      genre: book.genre ?? "",
      publishedYear: book.publishedYear?.toString() ?? "",
      description: book.description ?? "",
      coverUrl: book.coverUrl ?? ""
    });
    setShowBookEditor(true);
  };

  const deleteBook = async (bookId: string) => {
    if (!window.confirm("Delete this book? This cannot be undone.")) {
      return;
    }
    try {
      await authRequest(`/books/${bookId}`, { method: "DELETE" });
      setMessage("Book deleted.");
      await loadBooks();
    } catch (error) {
      setMessage(parseApiError(error));
    }
  };

  const checkoutBook = async (bookId: string) => {
    try {
      await authRequest("/loans/checkout", {
        method: "POST",
        body: { bookId }
      });
      setMessage("Book checked out.");
      await Promise.all([loadBooks(), loadLoans(), loadRecommendations()]);
    } catch (error) {
      setMessage(parseApiError(error));
    }
  };

  const checkinBook = async (bookId: string) => {
    try {
      await authRequest("/loans/checkin", {
        method: "POST",
        body: { bookId }
      });
      setMessage("Book checked in.");
      await Promise.all([loadBooks(), loadLoans(), loadRecommendations()]);
    } catch (error) {
      setMessage(parseApiError(error));
    }
  };

  const updateUserRole = async (userId: string, role: Role) => {
    try {
      await authRequest(`/users/${userId}/role`, {
        method: "PATCH",
        body: { role }
      });
      setMessage("User role updated.");
      await loadUsers();
    } catch (error) {
      setMessage(parseApiError(error));
    }
  };

  if (booting) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <h1>Starting MLMS...</h1>
          <p className="muted">Loading user session and secure API state.</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return <LoginScreen onGoogleCredential={loginWithGoogleCredential} busy={false} message={message} />;
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="topbar">
        <div>
          <p className="eyebrow">Mini Library Management System</p>
          <h1>Hi, {user.name}</h1>
          <p className="muted">
            Signed in as <strong>{user.role}</strong> | API: {getApiBaseUrl()}
          </p>
        </div>
        <button className="btn btn-outline" onClick={logout} type="button">
          Sign out
        </button>
      </header>

      <main id="main-content" className="page">
        <p className="notice" aria-live="polite">
          {message}
        </p>

        <section className="panel" aria-labelledby="books-title">
          <div className="panel-head">
            <h2 id="books-title">Books</h2>
            {canManageBooks && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setShowBookEditor((value) => !value);
                  if (showBookEditor) {
                    resetBookForm();
                  }
                }}
              >
                {showBookEditor ? "Close editor" : "Add a book"}
              </button>
            )}
          </div>

          <form
            className="filters"
            onSubmit={(event) => {
              event.preventDefault();
              void loadBooks();
            }}
          >
            <label>
              Search by title, author, genre, ISBN
              <input value={query} onChange={(event) => setQuery(event.target.value)} name="q" />
            </label>

            <label>
              Availability
              <select value={availableFilter} onChange={(event) => setAvailableFilter(event.target.value)}>
                <option value="all">All</option>
                <option value="available">Available</option>
                <option value="unavailable">Checked out</option>
              </select>
            </label>

            <button className="btn" type="submit" disabled={booksLoading}>
              {booksLoading ? "Searching..." : "Apply filters"}
            </button>
          </form>

          {showBookEditor && canManageBooks && (
            <section className="editor" aria-labelledby="editor-title">
              <h3 id="editor-title">{editingBookId ? "Edit book" : "Add new book"}</h3>
              <div className="editor-grid">
                <label>
                  Title
                  <input
                    value={bookForm.title}
                    onChange={(event) => setBookForm((prev) => ({ ...prev, title: event.target.value }))}
                    required
                  />
                </label>
                <label>
                  Author
                  <input
                    value={bookForm.author}
                    onChange={(event) => setBookForm((prev) => ({ ...prev, author: event.target.value }))}
                    required
                  />
                </label>
                <label>
                  ISBN
                  <input
                    value={bookForm.isbn}
                    onChange={(event) => setBookForm((prev) => ({ ...prev, isbn: event.target.value }))}
                  />
                </label>
                <label>
                  Genre
                  <input
                    value={bookForm.genre}
                    onChange={(event) => setBookForm((prev) => ({ ...prev, genre: event.target.value }))}
                  />
                </label>
                <label>
                  Published year
                  <input
                    type="number"
                    min={0}
                    max={2100}
                    value={bookForm.publishedYear}
                    onChange={(event) => setBookForm((prev) => ({ ...prev, publishedYear: event.target.value }))}
                  />
                </label>
                <label>
                  Cover URL
                  <input
                    type="url"
                    value={bookForm.coverUrl}
                    onChange={(event) => setBookForm((prev) => ({ ...prev, coverUrl: event.target.value }))}
                  />
                </label>
                <label className="full-width">
                  Description
                  <textarea
                    rows={3}
                    value={bookForm.description}
                    onChange={(event) => setBookForm((prev) => ({ ...prev, description: event.target.value }))}
                  />
                </label>
              </div>
              <div className="row-actions">
                <button className="btn" type="button" disabled={submittingBook} onClick={() => void submitBook()}>
                  {submittingBook ? "Saving..." : editingBookId ? "Save changes" : "Create book"}
                </button>
                <button className="btn btn-outline" type="button" onClick={resetBookForm}>
                  Cancel
                </button>
              </div>
            </section>
          )}

          <div className="book-grid">
            {books.map((book) => (
              <article className="book-card" key={book.id}>
                <header>
                  <h3>{book.title}</h3>
                  <p className="muted">{book.author}</p>
                </header>
                <p className={`status-pill ${book.available ? "available" : "unavailable"}`}>
                  {book.available ? "Available" : "Checked out"}
                </p>
                <p>{book.genre ?? "Uncategorized"}</p>
                {book.description && <p className="muted">{book.description}</p>}
                <div className="row-actions">
                  {book.available ? (
                    <button className="btn" type="button" onClick={() => void checkoutBook(book.id)}>
                      Check out
                    </button>
                  ) : (
                    <span className="muted">Currently borrowed</span>
                  )}
                  {canManageBooks && (
                    <>
                      <button className="btn btn-outline" type="button" onClick={() => editBook(book)}>
                        Edit
                      </button>
                      <button className="btn btn-danger" type="button" onClick={() => void deleteBook(book.id)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>

          {hasNextPage && (
            <button className="btn btn-outline" type="button" onClick={() => void loadBooks(nextCursor)} disabled={!nextCursor}>
              Load more
            </button>
          )}
        </section>

        <section className="panel two-col">
          <section aria-labelledby="loans-title">
            <div className="panel-head">
              <h2 id="loans-title">Active loans</h2>
              <button className="btn btn-outline" type="button" onClick={() => void loadLoans()} disabled={loansLoading}>
                Refresh
              </button>
            </div>
            <ul className="stack-list">
              {activeLoans.length === 0 && <li className="muted">No active loans.</li>}
              {activeLoans.map((loan) => (
                <li key={loan.id} className="row-item">
                  <div>
                    <strong>{loan.book.title}</strong>
                    <p className="muted">
                      Borrowed by {loan.user.name} on {new Date(loan.checkedOutAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button className="btn btn-outline" type="button" onClick={() => void checkinBook(loan.bookId)}>
                    Check in
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="ai-title">
            <div className="panel-head">
              <h2 id="ai-title">AI recommendations</h2>
              <button
                className="btn btn-outline"
                type="button"
                onClick={() => void loadRecommendations()}
                disabled={recommendationsLoading}
              >
                Refresh
              </button>
            </div>
            <ul className="stack-list">
              {recommendations.length === 0 && <li className="muted">No recommendations yet.</li>}
              {recommendations.map((book) => (
                <li key={book.id} className="row-item">
                  <div>
                    <strong>{book.title}</strong>
                    <p className="muted">
                      {book.author} | {book.genre ?? "General"}
                    </p>
                  </div>
                  {book.available && (
                    <button className="btn" type="button" onClick={() => void checkoutBook(book.id)}>
                      Check out
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </section>

        {user.role === "ADMIN" && (
          <section className="panel" aria-labelledby="users-title">
            <div className="panel-head">
              <h2 id="users-title">User roles</h2>
              <button className="btn btn-outline" type="button" onClick={() => void loadUsers()} disabled={adminLoading}>
                Refresh users
              </button>
            </div>
            <p className="muted">Use this section to enforce role-based permissions for library operations.</p>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Users and role assignments</caption>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Update</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((member) => (
                    <tr key={member.id}>
                      <td>{member.name}</td>
                      <td>{member.email}</td>
                      <td>{member.role}</td>
                      <td>
                        <label className="sr-only" htmlFor={`role-${member.id}`}>
                          Set role for {member.name}
                        </label>
                        <select
                          id={`role-${member.id}`}
                          defaultValue={member.role}
                          onChange={(event) => void updateUserRole(member.id, event.target.value as Role)}
                        >
                          <option value="MEMBER">MEMBER</option>
                          <option value="ADMIN">ADMIN</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </>
  );
};

export default App;
