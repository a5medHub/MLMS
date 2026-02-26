import { useMemo, useState } from "react";

type PreviewMode = "A" | "B" | "C";

const books = [
  { title: "The Time Machine", author: "H. G. Wells", rating: 4.6, genre: "Fiction" },
  { title: "Moby-Dick", author: "Herman Melville", rating: 4.1, genre: "Adventure" },
  { title: "The Mysterious Affair at Styles", author: "Agatha Christie", rating: 4.4, genre: "Mystery" },
  { title: "War and Peace", author: "Leo Tolstoy", rating: 4.5, genre: "Classic" },
  { title: "The Great Gatsby", author: "F. Scott Fitzgerald", rating: 4.3, genre: "Classic" },
  { title: "To Kill a Mockingbird", author: "Harper Lee", rating: 4.7, genre: "Drama" }
];

const modeLabel: Record<PreviewMode, string> = {
  A: "Option A: Bookstore Home",
  B: "Option B: Librarian Workspace",
  C: "Option C: Personalized Dashboard"
};

const Rating = ({ value }: { value: number }) => {
  const rounded = Math.round(value);
  const stars = `${"*".repeat(rounded)}${".".repeat(Math.max(0, 5 - rounded))}`;
  return (
    <p className="preview-rating">
      {stars} {value.toFixed(1)}
    </p>
  );
};

const BookCards = ({ compact = false }: { compact?: boolean }) => {
  return (
    <div className={`preview-book-grid ${compact ? "compact" : ""}`}>
      {books.map((book) => (
        <article key={book.title} className="preview-book-card">
          <div className="preview-cover" aria-hidden="true" />
          <h4>{book.title}</h4>
          <p className="preview-muted">{book.author}</p>
          <Rating value={book.rating} />
          <p className="preview-chip">{book.genre}</p>
          <button type="button" className="preview-btn">
            Borrow
          </button>
        </article>
      ))}
    </div>
  );
};

const OptionA = () => (
  <section className="preview-canvas">
    <header className="preview-hero">
      <div>
        <p className="preview-kicker">Editorial picks</p>
        <h2>Find your next book in seconds</h2>
        <p className="preview-muted">Storefront layout with discovery rows and rich cards.</p>
      </div>
      <div className="preview-hero-actions">
        <button type="button" className="preview-btn">
          Browse all
        </button>
        <button type="button" className="preview-btn outline">
          My dashboard
        </button>
      </div>
    </header>
    <section className="preview-row">
      <h3>Trending now</h3>
      <BookCards compact />
    </section>
    <section className="preview-row">
      <h3>Available now</h3>
      <BookCards compact />
    </section>
  </section>
);

const OptionB = () => (
  <section className="preview-canvas">
    <section className="preview-dashboard-head">
      <article>
        <h3>Due soon</h3>
        <p className="preview-muted">2 books due in the next 3 days</p>
      </article>
      <article>
        <h3>My loans</h3>
        <p className="preview-muted">5 active books</p>
      </article>
      <article>
        <h3>Recommendations</h3>
        <p className="preview-muted">Based on your recent history</p>
      </article>
    </section>

    <section className="workspace">
      <section className="preview-sidebar">
        <article className="preview-total-books">
          <p className="preview-kicker">Catalog</p>
          <strong>248 books available</strong>
        </article>
        <h3>Quick filters</h3>
        <label>
          Search
          <input value="mystery" readOnly />
        </label>
        <label>
          Availability
          <select value="available" disabled>
            <option>Available</option>
          </select>
        </label>
        <button type="button" className="preview-btn">
          Apply
        </button>
      </section>
      <section className="preview-main">
        <BookCards />
      </section>
    </section>
  </section>
);

const OptionC = () => (
  <section className="preview-canvas">
    <section className="preview-dashboard-head">
      <article>
        <h3>Due soon</h3>
        <p className="preview-muted">2 books due in the next 3 days</p>
      </article>
      <article>
        <h3>My loans</h3>
        <p className="preview-muted">5 active books</p>
      </article>
      <article>
        <h3>Recommendations</h3>
        <p className="preview-muted">Based on your recent history</p>
      </article>
    </section>
    <section className="preview-row">
      <h3>Continue reading</h3>
      <BookCards compact />
    </section>
    <section className="preview-row">
      <h3>Recommended for you</h3>
      <BookCards compact />
    </section>
  </section>
);

export const UiOptionsPreview = () => {
  const [mode, setMode] = useState<PreviewMode>("A");

  const view = useMemo(() => {
    if (mode === "A") {
      return <OptionA />;
    }
    if (mode === "B") {
      return <OptionB />;
    }
    return <OptionC />;
  }, [mode]);

  return (
    <main className="ui-preview-page">
      <header className="ui-preview-header">
        <div>
          <h1>UI Concept Preview</h1>
          <p className="preview-muted">
            Switch between options, then tell me which one to fully implement in the app.
          </p>
          <p className="preview-url-tip">
            Open this page anytime at <code>?preview=ui</code>
          </p>
        </div>
        <div className="ui-preview-tabs" role="tablist" aria-label="UI options">
          {(["A", "B", "C"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              className={`preview-tab ${mode === item ? "active" : ""}`}
              onClick={() => setMode(item)}
            >
              {modeLabel[item]}
            </button>
          ))}
        </div>
      </header>

      {view}
    </main>
  );
};
