export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

// 5460 -> "1 h 31 min", 540 -> "9 min"
export function formatDuration(totalSeconds: number) {
  let minutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  if (hours === 0) return `${Math.max(minutes, 1)} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
