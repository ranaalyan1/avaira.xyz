import { useEffect } from "react";

/**
 * Sets the document title for the current route.
 *
 * Every page needs this: without it the tab keeps whatever the previous route
 * (or the static index.html) set, so all the pixel marketing pages shared one
 * title at runtime even though the prerendered snapshots each carried their
 * own. It lives in lib/ rather than the immersive shell so the pixel pages can
 * use it without importing the immersive stylesheet.
 */
export const usePageTitle = (title) => {
  useEffect(() => {
    if (typeof document !== "undefined" && title && document.title !== title) {
      document.title = title;
    }
  }, [title]);
};
