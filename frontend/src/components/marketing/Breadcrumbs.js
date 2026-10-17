/**
 * Breadcrumb trail for the marketing pages.
 *
 * Markup is a plain ordered list (the separator is drawn by the stylesheet,
 * so the rendered HTML stays glyph-free); the matching BreadcrumbList
 * JSON-LD is emitted by the page through useSeo + breadcrumbJsonLd, keeping
 * the visible trail and the structured data generated from one array.
 */
import { Link } from "react-router-dom";

export default function Breadcrumbs({ trail }) {
  if (!trail || trail.length < 2) return null;
  const last = trail.length - 1;
  return (
    <nav className="px-crumbs" aria-label="Breadcrumb" data-testid="breadcrumbs">
      <ol>
        {trail.map(([label, to], i) => (
          <li key={to}>
            {i === last ? (
              <span aria-current="page">{label}</span>
            ) : (
              <Link to={to}>{label}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
