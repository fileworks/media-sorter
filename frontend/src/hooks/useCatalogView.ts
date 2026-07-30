/**
 * A list backed by the catalog rather than by an array in memory.
 *
 * Pages arrive by cursor and accumulate; nothing counts or holds the whole
 * library. The generation is checked on every page, because appending rows from
 * a rescan onto rows from the previous one would silently mix two libraries.
 *
 * `loadMore` is idempotent while a request is in flight, so a virtualized list
 * that reaches the end during a fast scroll asks once, not eleven times.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/services/api";
import type { CatalogViewRow } from "@/services/api";
import { extractErrorMessage } from "@/lib/errorUtils";

export interface CatalogViewQuery {
  roles?: string[];
  sort?: "path" | "size" | "modified";
  descending?: boolean;
  search?: string;
  pageSize?: number;
}

export interface CatalogView {
  rows: CatalogViewRow[];
  totalRows: number;
  totalBytes: number;
  loading: boolean;
  error: string | null;
  exhausted: boolean;
  /** Ask for the next page. Safe to call repeatedly. */
  loadMore: () => void;
  reset: () => void;
}

function queryKey(query: CatalogViewQuery): string {
  return JSON.stringify({
    roles: [...(query.roles ?? ["input", "destination", "reference"])].sort(),
    sort: query.sort ?? "path",
    descending: query.descending ?? false,
    search: (query.search ?? "").trim().toLowerCase(),
  });
}

export function useCatalogView(query: CatalogViewQuery): CatalogView {
  const key = queryKey(query);
  const [rows, setRows] = useState<CatalogViewRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [totals, setTotals] = useState({ rows: 0, bytes: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef<number | null>(null);
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    setRows([]);
    setCursor(null);
    setExhausted(false);
    setError(null);
    generationRef.current = null;
  }, []);

  // A changed query is a different list: the accumulated rows and the cursor
  // both belong to the old one.
  useEffect(() => reset(), [key, reset]);

  const loadMore = useCallback(() => {
    if (inFlight.current || exhausted) return;
    inFlight.current = true;
    setLoading(true);
    api
      .listCatalogView({
        cursor,
        limit: query.pageSize ?? 100,
        roles: query.roles,
        sort: query.sort,
        descending: query.descending,
        search: query.search,
        includeTotals: cursor === null,
      })
      .then((page) => {
        if (generationRef.current !== null && page.generation !== generationRef.current) {
          // The library was rescanned mid-list. Starting over is the only honest
          // option: these rows are not the same set as the ones above them.
          reset();
          return;
        }
        generationRef.current = page.generation;
        setRows((current) => [...current, ...page.rows]);
        setCursor(page.next_cursor);
        setExhausted(page.next_cursor === null);
        if (page.total_rows > 0 || cursor === null) {
          setTotals({ rows: page.total_rows, bytes: page.total_bytes });
        }
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(extractErrorMessage(cause, "The list could not be loaded."));
      })
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
      });
  }, [
    cursor,
    exhausted,
    query.descending,
    query.pageSize,
    query.roles,
    query.search,
    query.sort,
    reset,
  ]);

  // The first page loads itself; later ones are asked for by the list.
  useEffect(() => {
    if (rows.length === 0 && !exhausted && !inFlight.current) {
      loadMore();
    }
  }, [rows.length, exhausted, loadMore]);

  return {
    rows,
    totalRows: totals.rows,
    totalBytes: totals.bytes,
    loading,
    error,
    exhausted,
    loadMore,
    reset,
  };
}
