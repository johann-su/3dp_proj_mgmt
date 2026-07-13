// How many items a listing returns per page (homepage feed, /search).
export const PAGE_SIZE = 24;

// A page of items plus the opaque cursor to fetch the next one (null = end).
export type Page<T> = { items: T[]; nextCursor: string | null };
