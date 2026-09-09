/** Build CSV text from simulation result { times, series }. */
export function resultToCsv(result) {
  if (!result?.times?.length || !result.series) return "";
  const names = Object.keys(result.series);
  const xLabel = result.xUnit === "Hz" ? "freq_Hz" : "time_s";
  const header = [xLabel, ...names].join(",");
  const rows = result.times.map((t, i) => {
    const cells = [t, ...names.map((n) => result.series[n][i])];
    return cells.map(csvNum).join(",");
  });
  return [header, ...rows].join("\n");
}

function csvNum(v) {
  if (!Number.isFinite(v)) return "";
  return String(v);
}

export function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
