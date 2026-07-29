"use client";

// TEMPORARY (v4.0.1) — on-device safe-area diagnostic. Removed once the
// standalone-PWA inset fix is verified on the owner's iPhone.

import { useEffect, useState } from "react";

type Row = [string, string];

export default function Diag() {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    // A probe element whose padding is the raw env() values — reading its
    // computed style is the only reliable way to get the resolved insets.
    const probe = document.createElement("div");
    probe.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "visibility:hidden",
      "padding-top:env(safe-area-inset-top)",
      "padding-right:env(safe-area-inset-right)",
      "padding-bottom:env(safe-area-inset-bottom)",
      "padding-left:env(safe-area-inset-left)",
    ].join(";");
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const insets = {
      top: cs.paddingTop,
      right: cs.paddingRight,
      bottom: cs.paddingBottom,
      left: cs.paddingLeft,
    };
    probe.remove();

    const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "(none)";
    const statusBar =
      document
        .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
        ?.getAttribute("content") ?? "(none)";
    const vv = window.visualViewport;

    setRows([
      ["inset-top", insets.top],
      ["inset-bottom", insets.bottom],
      ["inset-left / right", `${insets.left} / ${insets.right}`],
      ["standalone (display-mode)", String(window.matchMedia("(display-mode: standalone)").matches)],
      ["standalone (navigator)", String((navigator as unknown as { standalone?: boolean }).standalone)],
      ["innerWidth × innerHeight", `${window.innerWidth} × ${window.innerHeight}`],
      ["screen", `${screen.width} × ${screen.height} @${window.devicePixelRatio}x`],
      ["visualViewport", vv ? `${Math.round(vv.width)} × ${Math.round(vv.height)} off ${vv.offsetTop}` : "n/a"],
      ["meta viewport", meta],
      ["status-bar-style", statusBar],
    ]);
  }, []);

  return (
    <main style={{ fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.5 }}>
      {/* A red band exactly as tall as the top inset: whatever it covers is
          what the notch/status bar is currently eating. */}
      <div
        style={{
          height: "env(safe-area-inset-top)",
          background: "rgba(244,154,145,0.5)",
          borderBottom: "1px solid #f49a91",
        }}
      />
      <div style={{ background: "#506bf2", color: "#fff", padding: "6px 12px", fontWeight: 700 }}>
        ↑ TOP OF CONTENT — is this line fully visible?
      </div>
      <div style={{ padding: 12 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td style={{ padding: "3px 8px 3px 0", color: "rgba(255,255,255,0.5)", verticalAlign: "top" }}>
                  {k}
                </td>
                <td style={{ padding: "3px 0", wordBreak: "break-all" }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        style={{
          position: "fixed",
          insetInline: 0,
          bottom: 0,
          height: "env(safe-area-inset-bottom)",
          background: "rgba(147,216,168,0.5)",
          borderTop: "1px solid #93d8a8",
        }}
      />
    </main>
  );
}
