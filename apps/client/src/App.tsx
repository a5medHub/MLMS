import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, requestJson } from "./lib/api-client";
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

type SearchFallbackResponse = {
  data: Book[];
  meta?: {
    source?: string | null;
    fallbackUsed?: boolean;
    importedCount?: number;
    existingCount?: number;
  };
};

type EnrichMetadataResponse = {
  meta: {
    providerUsed: string;
    processed: number;
    updatedCount: number;
    skippedCount: number;
    noMatchCount: number;
    failedCount: number;
  };
};

type BorrowerOverview = {
  user: Pick<User, "id" | "name" | "email">;
  activeLoans: Loan[];
  overdueCount: number;
};

type AdminLoansOverviewResponse = {
  data: {
    borrowers: BorrowerOverview[];
    overdueLoans: Loan[];
    overdueUsers: number;
  };
};

type ImportProvider = "auto" | "openlibrary" | "google";
type ViewMode = "catalog" | "dashboard";

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

const toDateInputValue = (isoDate: string | null): string => {
  if (!isoDate) {
    return "";
  }
  return new Date(isoDate).toISOString().slice(0, 10);
};

const truncateText = (value: string, maxLength = 100): string => {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
};

const getBookCoverCandidates = (book: Book): string[] => {
  const candidates: string[] = [];
  if (book.coverUrl) {
    candidates.push(book.coverUrl);
  }
  if (book.isbn) {
    candidates.push(`https://covers.openlibrary.org/b/isbn/${book.isbn}-L.jpg`);
  }
  const googleQuery = encodeURIComponent(`intitle:${book.title} inauthor:${book.author}`);
  candidates.push(`https://books.google.com/books/content?printsec=frontcover&img=1&zoom=1&source=gbs_api&q=${googleQuery}`);
  return [...new Set(candidates)];
};

const formatRatingCount = (count: number | null): string => {
  if (!count) {
    return "0";
  }
  return Intl.NumberFormat().format(count);
};

const BookRating = ({ book }: { book: Book }) => {
  if (book.averageRating === null) {
    return <p className="rating-line muted">No ratings yet</p>;
  }

  const rounded = Math.round(book.averageRating);
  const stars = `${"*".repeat(rounded)}${".".repeat(Math.max(0, 5 - rounded))}`;

  return (
    <p className="rating-line" aria-label={`${book.averageRating.toFixed(1)} out of 5`}>
      <span className="rating-stars" aria-hidden="true">
        {stars}
      </span>
      <span className="rating-value">{book.averageRating.toFixed(1)}</span>
      <span className="rating-count">({formatRatingCount(book.ratingsCount)})</span>
    </p>
  );
};

const BookCover = ({ book, className }: { book: Book; className: string }) => {
  const [candidateIndex, setCandidateIndex] = useState(0);
  const coverCandidates = useMemo(() => getBookCoverCandidates(book), [book]);

  useEffect(() => {
    setCandidateIndex(0);
  }, [book]);

  const fallbackLabel = book.title
    .split(" ")
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  if (coverCandidates.length === 0 || candidateIndex >= coverCandidates.length) {
    return <div className={`${className} cover-fallback`}>{fallbackLabel || "BK"}</div>;
  }

  return (
    <img
      className={className}
      src={coverCandidates[candidateIndex]}
      alt={`Cover of ${book.title}`}
      loading="lazy"
      onError={() => setCandidateIndex((current) => current + 1)}
    />
  );
};

const BookPreviewDialog = ({
  book,
  onClose,
  onCheckout
}: {
  book: Book | null;
  onClose: () => void;
  onCheckout: (bookId: string) => Promise<void>;
}) => {
  useEffect(() => {
    if (!book) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [book, onClose]);

  if (!book) {
    return null;
  }

  const externalInfoUrl = `https://openlibrary.org/search?q=${encodeURIComponent(`${book.title} ${book.author}`)}`;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-preview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="book-preview-title">Book preview</h2>
          <button className="btn btn-outline" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-content">
          <BookCover book={book} className="book-cover-large" />
          <div className="modal-info">
            <h3>{book.title}</h3>
            <p className="muted">{book.author}</p>
            <BookRating book={book} />
            <p>
              <strong>Genre:</strong> {book.genre ?? "Uncategorized"}
            </p>
            <p>
              <strong>Published:</strong> {book.publishedYear ?? "Unknown"}
            </p>
            <p>
              <strong>ISBN:</strong> {book.isbn ?? "N/A"}
            </p>
            <p className="book-description">
              {book.description ??
                "No summary available for this book yet. Try importing from Google Books for richer metadata."}
            </p>
            <a className="text-link" href={externalInfoUrl} target="_blank" rel="noreferrer">
              More details
            </a>
            <div className="row-actions">
              {book.available ? (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    void onCheckout(book.id);
                    onClose();
                  }}
                >
                  Borrow this book
                </button>
              ) : (
                <span className="muted">This book is currently borrowed.</span>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

const GoogleSignInButton = ({
  onGoogleCredential,
  targetId,
  width = 220
}: {
  onGoogleCredential: (credential: string) => Promise<void>;
  targetId: string;
  width?: number;
}) => {
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

  useEffect(() => {
    if (!googleClientId) {
      return;
    }

    const renderButton = () => {
      const target = document.getElementById(targetId);
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
        size: "medium",
        shape: "pill",
        width
      });
    };

    if (window.google?.accounts?.id) {
      renderButton();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>("script[data-google-signin='true']");
    if (existingScript) {
      existingScript.addEventListener("load", renderButton);
      return () => {
        existingScript.removeEventListener("load", renderButton);
      };
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleSignin = "true";
    script.onload = renderButton;
    document.body.appendChild(script);
  }, [googleClientId, onGoogleCredential, targetId, width]);

  return (
    <div>
      <div id={targetId} aria-label="Google Sign In button" />
      {!googleClientId && (
        <p className="notice" role="alert">
          Missing <code>VITE_GOOGLE_CLIENT_ID</code>.
        </p>
      )}
    </div>
  );
};

const ProfileMenu = ({
  user,
  busy,
  message,
  borrowedCount,
  onGoogleCredential,
  onLogout,
  onOpenDashboard
}: {
  user: User | null;
  busy: boolean;
  message: string;
  borrowedCount: number;
  onGoogleCredential: (credential: string) => Promise<void>;
  onLogout: () => void;
  onOpenDashboard: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      const element = rootRef.current;
      if (!element || element.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onEscape);
    };
  }, []);

  const initials = user?.name
    .split(" ")
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") ?? "U";

  return (
    <div className="topbar-actions" ref={rootRef}>
      <button
        className="profile-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={user ? `Open profile menu for ${user.name}` : "Open profile menu"}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="profile-avatar">{initials}</span>
      </button>

      {open && (
        <section className="profile-dropdown" role="menu" aria-label="Profile menu">
          {!user ? (
            <>
              <p className="profile-title">Guest mode</p>
              <p className="muted">Browse books now. Sign in to borrow.</p>
              <GoogleSignInButton onGoogleCredential={onGoogleCredential} targetId="google-signin-profile" width={205} />
              {busy && <p className="profile-status muted">Signing in...</p>}
              <p className="profile-status notice" aria-live="polite">
                {message}
              </p>
            </>
          ) : (
            <>
              <p className="profile-title">{user.name}</p>
              <p className="muted">
                {user.email} | {user.role}
              </p>
              <p className="profile-section-title">Borrowed books: {borrowedCount}</p>
              <div className="profile-actions-row">
                <button
                  className="btn btn-outline profile-btn-small"
                  type="button"
                  onClick={() => {
                    onOpenDashboard();
                    setOpen(false);
                  }}
                >
                  Dashboard
                </button>
                <button
                  className="btn btn-outline profile-btn-small"
                  onClick={() => {
                    onLogout();
                    setOpen(false);
                  }}
                  type="button"
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
};

const App = () => {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() => localStorage.getItem("mlms_access_token"));
  const [message, setMessage] = useState("Welcome.");
  const [signingIn, setSigningIn] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("catalog");

  const [books, setBooks] = useState<Book[]>([]);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [booksLoading, setBooksLoading] = useState(false);

  const [loans, setLoans] = useState<Loan[]>([]);
  const [loansLoading, setLoansLoading] = useState(false);
  const [borrowersOverview, setBorrowersOverview] = useState<BorrowerOverview[]>([]);
  const [overdueLoans, setOverdueLoans] = useState<Loan[]>([]);
  const [overdueUsersCount, setOverdueUsersCount] = useState(0);
  const [adminOverviewLoading, setAdminOverviewLoading] = useState(false);
  const [dueDateDrafts, setDueDateDrafts] = useState<Record<string, string>>({});
  const [dueDateUpdatingId, setDueDateUpdatingId] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<Book[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);

  const [query, setQuery] = useState("");
  const [availableFilter, setAvailableFilter] = useState("all");
  const [importQuery, setImportQuery] = useState("popular fiction");
  const [importLimit, setImportLimit] = useState("50");
  const [importProvider, setImportProvider] = useState<ImportProvider>("auto");
  const [importingExternal, setImportingExternal] = useState(false);
  const [enrichLimit, setEnrichLimit] = useState("200");
  const [enrichingMetadata, setEnrichingMetadata] = useState(false);
  const [previewBook, setPreviewBook] = useState<Book | null>(null);
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

        const result = await requestJson<BooksResponse>(`/books?${params.toString()}`);
        const isInitialSearch = !cursor;
        if (isInitialSearch && query.trim() && result.data.length === 0 && user) {
          const fallback = await requestJson<SearchFallbackResponse>(
            `/search/books?q=${encodeURIComponent(query.trim())}&limit=12&withFallback=true`
          );
          setBooks(fallback.data);
          setHasNextPage(false);
          setNextCursor(null);
          if (fallback.data.length > 0 && fallback.meta?.source && fallback.meta.source !== "local") {
            setMessage(`No local results. Imported from ${fallback.meta.source}.`);
          }
          return;
        }

        setBooks((previous) => (cursor ? [...previous, ...result.data] : result.data));
        setHasNextPage(result.pageInfo.hasNextPage);
        setNextCursor(result.pageInfo.nextCursor);
      } catch (error) {
        setMessage(parseApiError(error));
      } finally {
        setBooksLoading(false);
      }
    },
    [availableFilter, query, user]
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
      const result = await requestJson<{ data: Book[] }>("/ai/recommendations", {
        method: "POST",
        body: { limit: 8 },
        accessToken: tokenRef.current
      });
      setRecommendations(result.data);
    } catch (error) {
      setMessage(parseApiError(error));
    } finally {
      setRecommendationsLoading(false);
    }
  }, []);

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

  const loadAdminOverview = useCallback(async () => {
    if (user?.role !== "ADMIN") {
      return;
    }
    setAdminOverviewLoading(true);
    try {
      const result = await authRequest<AdminLoansOverviewResponse>("/loans/admin/overview");
      setBorrowersOverview(result.data.borrowers);
      setOverdueLoans(result.data.overdueLoans);
      setOverdueUsersCount(result.data.overdueUsers);
    } catch (error) {
      setMessage(parseApiError(error));
    } finally {
      setAdminOverviewLoading(false);
    }
  }, [authRequest, user?.role]);

  const refreshAfterLoanMutation = useCallback(async () => {
    await Promise.all([loadBooks(), loadLoans(), loadRecommendations(), loadAdminOverview()]);
  }, [loadAdminOverview, loadBooks, loadLoans, loadRecommendations]);

  const bootAuth = useCallback(async () => {
    let token = tokenRef.current;
    if (!token) {
      setUser(null);
      setAccessToken(null);
      setMessage("Browse the catalog. Sign in only when you want to borrow.");
      setBooting(false);
      return;
    }

    try {
      const me = await requestJson<{ user: User }>("/auth/me", { accessToken: token });
      setUser(me.user);
      setAccessToken(token);
      setMessage(`Welcome back, ${me.user.name}.`);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 401) {
        try {
          token = await refreshAccessToken();
          const me = await requestJson<{ user: User }>("/auth/me", { accessToken: token });
          setUser(me.user);
          setAccessToken(token);
          setMessage(`Welcome back, ${me.user.name}.`);
          return;
        } catch {
          // fall through to guest mode
        }
      }
      setUser(null);
      setAccessToken(null);
      setMessage("Browse the catalog. Sign in only when you want to borrow.");
    } finally {
      setBooting(false);
    }
  }, [refreshAccessToken]);

  useEffect(() => {
    void bootAuth();
  }, [bootAuth]);

  useEffect(() => {
    if (booting) {
      return;
    }
    void Promise.all([loadBooks(), loadRecommendations()]);
  }, [booting, loadBooks, loadRecommendations]);

  useEffect(() => {
    if (!user) {
      setLoans([]);
      setUsers([]);
      setBorrowersOverview([]);
      setOverdueLoans([]);
      setOverdueUsersCount(0);
      setDueDateDrafts({});
      return;
    }
    void Promise.all([loadLoans(), loadRecommendations(), loadUsers(), loadAdminOverview()]);
  }, [loadAdminOverview, loadLoans, loadRecommendations, loadUsers, user]);

  const loginWithGoogleCredential = useCallback(async (credential: string) => {
    try {
      setSigningIn(true);
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
    } finally {
      setSigningIn(false);
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
      setViewMode("catalog");
      setMessage("Signed out.");
      void loadRecommendations();
    }
  }, [loadRecommendations]);

  const activeLoans = useMemo(() => loans.filter((loan) => !loan.returnedAt), [loans]);
  const myActiveLoans = useMemo(() => {
    if (!user) {
      return [];
    }
    return activeLoans.filter((loan) => loan.userId === user.id);
  }, [activeLoans, user]);
  const canManageBooks = user?.role === "ADMIN";
  const canBorrow = !!user;

  const openUserDashboard = useCallback(() => {
    if (!user) {
      return;
    }
    setViewMode("dashboard");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [user]);

  const ensureSignedIn = useCallback(
    (action: string) => {
      if (user) {
        return true;
      }
      setMessage(`Sign in with Google to ${action}.`);
      return false;
    },
    [user]
  );

  useEffect(() => {
    if (user?.role !== "ADMIN") {
      return;
    }
    if (overdueLoans.length > 0) {
      setMessage(
        `Overdue alert: ${overdueLoans.length} book(s) across ${overdueUsersCount} borrower(s) passed due date.`
      );
    }
  }, [overdueLoans.length, overdueUsersCount, user?.role]);

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
    if (!ensureSignedIn("borrow books")) {
      return;
    }
    try {
      await authRequest("/loans/checkout", {
        method: "POST",
        body: { bookId }
      });
      setMessage("Book checked out.");
      await refreshAfterLoanMutation();
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
      await refreshAfterLoanMutation();
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

  const updateLoanDueDate = async (loan: Loan) => {
    const dueDate = dueDateDrafts[loan.id] ?? toDateInputValue(loan.dueAt);
    if (!dueDate) {
      setMessage("Select a due date before saving.");
      return;
    }

    try {
      setDueDateUpdatingId(loan.id);
      await authRequest<{ data: Loan }>(`/loans/${loan.id}/due-date`, {
        method: "PATCH",
        body: {
          dueAt: new Date(`${dueDate}T12:00:00.000Z`).toISOString()
        }
      });
      setMessage("Loan due date updated.");
      await Promise.all([loadLoans(), loadAdminOverview()]);
    } catch (error) {
      setMessage(parseApiError(error));
    } finally {
      setDueDateUpdatingId(null);
    }
  };

  const importFromExternal = async () => {
    try {
      setImportingExternal(true);
      const limitNumber = Number(importLimit);
      if (!Number.isFinite(limitNumber) || limitNumber < 1 || limitNumber > 300) {
        setMessage("Import limit must be between 1 and 300.");
        return;
      }

      const response = await authRequest<SearchFallbackResponse>("/books/import/external", {
        method: "POST",
        body: {
          query: importQuery,
          limit: limitNumber,
          provider: importProvider
        }
      });

      const importedCount = response.meta?.importedCount ?? response.data.length;
      const existingCount = response.meta?.existingCount ?? 0;
      setMessage(
        `Import finished from ${importProvider}. Added ${importedCount} new books, reused ${existingCount} existing.`
      );
      await loadBooks();
    } catch (error) {
      setMessage(parseApiError(error));
    } finally {
      setImportingExternal(false);
    }
  };

  const enrichLibraryMetadata = async () => {
    try {
      setEnrichingMetadata(true);
      const limitNumber = Number(enrichLimit);
      if (!Number.isFinite(limitNumber) || limitNumber < 1 || limitNumber > 500) {
        setMessage("Enrichment limit must be between 1 and 500.");
        return;
      }

      const response = await authRequest<EnrichMetadataResponse>("/books/enrich-metadata", {
        method: "POST",
        body: {
          limit: limitNumber,
          provider: importProvider,
          onlyMissing: true
        }
      });

      setMessage(
        `Enrichment done (${response.meta.providerUsed}). Updated ${response.meta.updatedCount}/${response.meta.processed}, unmatched ${response.meta.noMatchCount}, failed ${response.meta.failedCount}.`
      );
      await loadBooks();
    } catch (error) {
      setMessage(parseApiError(error));
    } finally {
      setEnrichingMetadata(false);
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

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="topbar">
        <div>
          <h1>{user ? `Hi, ${user.name}` : "Browse the public catalog"}</h1>
        </div>
        <ProfileMenu
          user={user}
          busy={signingIn}
          message={message}
          borrowedCount={myActiveLoans.length}
          onGoogleCredential={loginWithGoogleCredential}
          onLogout={logout}
          onOpenDashboard={openUserDashboard}
        />
      </header>

      <main id="main-content" className="page">
        {user && message && !message.startsWith("Signed in as ") && (
          <p className="notice" aria-live="polite">
            {message}
          </p>
        )}

        {viewMode === "dashboard" && user && (
          <section className="panel dashboard-nav" aria-label="Dashboard navigation">
            <p className="muted">Dashboard view includes your loans and management tools.</p>
            <button className="btn btn-outline dashboard-back-btn" type="button" onClick={() => setViewMode("catalog")}>
              Back to catalog
            </button>
          </section>
        )}

        {viewMode === "catalog" && (
          <>
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

          {canManageBooks && (
            <section className="import-box" aria-labelledby="import-title">
              <h3 id="import-title">Import books for testing</h3>
              <p className="muted">Primary source: Open Library. Automatic fallback: Google Books when not found.</p>
              <div className="import-grid">
                <label>
                  Query
                  <input value={importQuery} onChange={(event) => setImportQuery(event.target.value)} />
                </label>
                <label>
                  Limit (1-300)
                  <input
                    type="number"
                    min={1}
                    max={300}
                    value={importLimit}
                    onChange={(event) => setImportLimit(event.target.value)}
                  />
                </label>
                <label>
                  Source
                  <select
                    value={importProvider}
                    onChange={(event) => setImportProvider(event.target.value as ImportProvider)}
                  >
                    <option value="auto">Auto (Open Library then Google fallback)</option>
                    <option value="openlibrary">Open Library only</option>
                    <option value="google">Google Books only</option>
                  </select>
                </label>
                <button className="btn" type="button" onClick={() => void importFromExternal()} disabled={importingExternal}>
                  {importingExternal ? "Importing..." : "Import from APIs"}
                </button>
              </div>
              <div className="import-actions">
                <label>
                  Enrich existing books (1-500)
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={enrichLimit}
                    onChange={(event) => setEnrichLimit(event.target.value)}
                  />
                </label>
                <button
                  className="btn btn-outline"
                  type="button"
                  onClick={() => void enrichLibraryMetadata()}
                  disabled={enrichingMetadata}
                >
                  {enrichingMetadata ? "Enriching..." : "Enrich metadata"}
                </button>
              </div>
            </section>
          )}

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

          <div className="book-grid storefront-grid">
            {books.map((book) => (
              <article className="book-card storefront-book-card" key={book.id}>
                <div className="book-card-head storefront-book-head">
                  <BookCover book={book} className="book-cover-thumb" />
                  <header>
                    <h3>{book.title}</h3>
                    <p className="muted">{book.author}</p>
                    <BookRating book={book} />
                  </header>
                </div>
                <p className={`status-pill ${book.available ? "available" : "unavailable"}`}>
                  {book.available ? "Available" : "Checked out"}
                </p>
                <p className="book-genre">{book.genre ?? "Uncategorized"}</p>
                <p className="muted clamp-3">
                  {book.description ?? "No description yet. Click Preview to view more details."}
                </p>
                <div className="row-actions book-card-actions">
                  <button className="btn btn-outline" type="button" onClick={() => setPreviewBook(book)}>
                    Preview
                  </button>
                  {book.available ? (
                    <button className="btn" type="button" onClick={() => void checkoutBook(book.id)} disabled={!canBorrow}>
                      {canBorrow ? "Borrow" : "Sign in to borrow"}
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

        <section className="panel shelf-panel" aria-labelledby="ai-title">
          <div className="panel-head">
            <h2 id="ai-title">{user ? "Recommended for you" : "Popular picks"}</h2>
          </div>
          {recommendationsLoading && <p className="muted">Updating recommendations...</p>}
          <div className="recommendation-shelf" role="list">
            {recommendations.length === 0 && <p className="muted">No recommendations yet.</p>}
            {recommendations.map((book) => (
              <article key={book.id} className="shelf-card" role="listitem">
                <BookCover book={book} className="book-cover-thumb shelf-cover" />
                <h3 className="shelf-title" title={book.title}>
                  {truncateText(book.title, 100)}
                </h3>
                <p className="muted shelf-author" title={book.author}>
                  {truncateText(book.author, 70)}
                </p>
                <BookRating book={book} />
                <p className="muted clamp-2 shelf-genre" title={book.genre ?? "General"}>
                  {truncateText(book.genre ?? "General", 100)}
                </p>
                {book.available && (
                  <button className="btn shelf-btn" type="button" onClick={() => void checkoutBook(book.id)} disabled={!canBorrow}>
                    {canBorrow ? "Borrow" : "Sign in to borrow"}
                  </button>
                )}
                {!book.available && <p className="muted shelf-status">Checked out</p>}
              </article>
            ))}
          </div>
        </section>
          </>
        )}

        {viewMode === "dashboard" && user && (
          <section className="panel two-col">
            <section id="loans-section" aria-labelledby="loans-title">
              <div className="panel-head">
                <h2 id="loans-title">Active loans</h2>
              </div>
              {loansLoading && <p className="muted">Updating loans...</p>}
              <ul className="stack-list">
                {activeLoans.length === 0 && <li className="muted">No active loans.</li>}
                {activeLoans.map((loan) => (
                  <li key={loan.id} className="row-item">
                    <div>
                      <strong>{loan.book.title}</strong>
                      <p className="muted">
                        Borrowed by {loan.user.name} on {new Date(loan.checkedOutAt).toLocaleDateString()}
                      </p>
                      <p className={loan.dueAt && new Date(loan.dueAt) < new Date() ? "overdue-text" : "muted"}>
                        Due: {loan.dueAt ? new Date(loan.dueAt).toLocaleDateString() : "Not set"}
                      </p>
                    </div>
                    <div className="row-actions">
                      {user.role === "ADMIN" && (
                        <>
                          <input
                            type="date"
                            value={dueDateDrafts[loan.id] ?? toDateInputValue(loan.dueAt)}
                            onChange={(event) =>
                              setDueDateDrafts((current) => ({ ...current, [loan.id]: event.target.value }))
                            }
                            aria-label={`Due date for ${loan.book.title}`}
                          />
                          <button
                            className="btn btn-outline"
                            type="button"
                            onClick={() => void updateLoanDueDate(loan)}
                            disabled={dueDateUpdatingId === loan.id}
                          >
                            {dueDateUpdatingId === loan.id ? "Saving..." : "Save due date"}
                          </button>
                        </>
                      )}
                      <button className="btn btn-outline" type="button" onClick={() => void checkinBook(loan.bookId)}>
                        Check in
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </section>
        )}

        {viewMode === "dashboard" && user?.role === "ADMIN" && (
          <section className="panel" aria-labelledby="borrowers-overview-title">
            <div className="panel-head">
              <h2 id="borrowers-overview-title">Borrowers and due alerts</h2>
              <button
                className="btn btn-outline"
                type="button"
                onClick={() => void loadAdminOverview()}
                disabled={adminOverviewLoading}
              >
                {adminOverviewLoading ? "Refreshing..." : "Refresh alerts"}
              </button>
            </div>
            {overdueLoans.length > 0 ? (
              <p className="overdue-banner">
                Alert: {overdueLoans.length} active loan(s) are overdue across {overdueUsersCount} borrower(s).
              </p>
            ) : (
              <p className="muted">No overdue loans right now.</p>
            )}

            <div className="borrowers-list">
              {borrowersOverview.length === 0 && <p className="muted">No active borrowers yet.</p>}
              {borrowersOverview.map((borrower) => (
                <article key={borrower.user.id} className="borrower-card">
                  <header>
                    <h3>{borrower.user.name}</h3>
                    <p className="muted">{borrower.user.email}</p>
                    <p className={borrower.overdueCount > 0 ? "overdue-text" : "muted"}>
                      Active books: {borrower.activeLoans.length} | Overdue: {borrower.overdueCount}
                    </p>
                  </header>
                  <ul className="stack-list">
                    {borrower.activeLoans.map((loan) => {
                      const isOverdue = !!loan.dueAt && new Date(loan.dueAt) < new Date();
                      return (
                        <li key={loan.id} className="row-item">
                          <div>
                            <strong>{loan.book.title}</strong>
                            <p className={isOverdue ? "overdue-text" : "muted"}>
                              Due: {loan.dueAt ? new Date(loan.dueAt).toLocaleDateString() : "Not set"}
                            </p>
                          </div>
                          <button className="btn btn-outline" type="button" onClick={() => void checkinBook(loan.bookId)}>
                            Check in
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </article>
              ))}
            </div>
          </section>
        )}

        {viewMode === "dashboard" && user?.role === "ADMIN" && (
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
      <BookPreviewDialog book={previewBook} onClose={() => setPreviewBook(null)} onCheckout={checkoutBook} />
    </>
  );
};

export default App;
