"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Shared app chrome for the Apple-dark design language: a slim translucent top
// nav on desktop and a bottom tab bar on mobile.
//
// v4.0 W6 — nav restructured around the vision's four primary surfaces:
//   Home (capture + ask) · Deck (the daily sweep) · Approvals · Ops (coverage).
// Everything deliberate-but-rare lives under "More": Imports (legacy, kept
// reachable), Interview, Graph, Sign out.
//
// Self-sufficient — fetches the owner email + the two badge counts from
// /api/me, so every page just drops in <AppNav />.

type BadgeKind = "approvals" | "deck";
type NavLink = { href: string; label: string; icon: string; badge?: BadgeKind };

// ---- icons -------------------------------------------------------------------
// Line icons rather than emoji: emoji render at different weights and colours
// per platform, which is exactly the inconsistency this pass removes.

const ICONS: Record<string, string> = {
  // house
  home: "M3.6 10.4 12 4l8.4 6.4V19a1.4 1.4 0 0 1-1.4 1.4h-3.6v-5.2H8.6v5.2H5a1.4 1.4 0 0 1-1.4-1.4Z",
  // stacked cards (the deck)
  deck: "M7.6 7.8h8.8a1.6 1.6 0 0 1 1.6 1.6v8.8a1.6 1.6 0 0 1-1.6 1.6H7.6A1.6 1.6 0 0 1 6 18.2V9.4a1.6 1.6 0 0 1 1.6-1.6ZM9.4 4.8h7.8a2.4 2.4 0 0 1 2.4 2.4v7.8",
  // checkmark in a circle
  approvals: "M8.4 12.3 11 14.9l4.8-5.3M12 3.8a8.2 8.2 0 1 1 0 16.4 8.2 8.2 0 0 1 0-16.4Z",
  // bar chart (coverage)
  ops: "M4.5 19.5h15M7.6 19.5v-6.2M12 19.5V7.2M16.4 19.5v-8.6",
  // ellipsis
  more: "M6 12h.01M12 12h.01M18 12h.01",
};

const PRIMARY: NavLink[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/deck", label: "Deck", icon: "deck", badge: "deck" },
  { href: "/approvals", label: "Approvals", icon: "approvals", badge: "approvals" },
  { href: "/ops", label: "Ops", icon: "ops" },
];

// Secondary surfaces — reachable, never in the way.
const SECONDARY: { href: string; label: string; hint: string }[] = [
  { href: "/imports", label: "Imports", hint: "legacy backlog" },
  { href: "/interview", label: "Interview", hint: "fill the gaps" },
  { href: "/graph", label: "Graph", hint: "links between items" },
];

const SECONDARY_HREFS = SECONDARY.map((l) => l.href);

function Icon({ path, active = false }: { path: string; active?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="23"
      height="23"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2.1 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={path} />
    </svg>
  );
}

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold tabular-nums text-white">
      {n > 99 ? "99+" : n}
    </span>
  );
}

function SignOut({ className = "" }: { className?: string }) {
  return (
    <form action="/auth/signout" method="post">
      <button type="submit" className={className}>
        Sign out
      </button>
    </form>
  );
}

export default function AppNav({ hideMobileBar = false }: { hideMobileBar?: boolean }) {
  const pathname = usePathname();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(0);
  const [deckPending, setDeckPending] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d) {
          setEmail(d.email ?? "");
          setPending(d.pending ?? 0);
          setDeckPending(d.deckPending ?? 0);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Re-close the More menu on navigation.
  useEffect(() => setMoreOpen(false), [pathname]);

  // Escape dismisses it — a menu should always be one key from gone.
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const moreActive = SECONDARY_HREFS.some((h) => pathname.startsWith(h));
  const badgeCount = (kind?: BadgeKind) =>
    kind === "deck" ? deckPending : kind === "approvals" ? pending : 0;

  const moreItems = (
    <>
      {SECONDARY.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={`flex min-h-11 items-center justify-between gap-3 rounded-control px-4 text-[15px] transition hover:bg-white/[0.06] ${
            isActive(l.href) ? "bg-white/[0.08] font-semibold text-ink" : "text-ink"
          }`}
        >
          {l.label}
          <span className="text-xs text-ink-3">{l.hint}</span>
        </Link>
      ))}
      <div className="my-1 h-px bg-hairline" />
      <SignOut className="flex min-h-11 w-full items-center rounded-control px-4 text-left text-[15px] text-danger transition hover:bg-white/[0.06]" />
    </>
  );

  return (
    <>
      {/* Desktop — slim translucent top nav */}
      {/* Sticks BELOW the safe-area strip, not at viewport 0 — otherwise it
          slides under the status bar on a notched device in standalone.
          Resolves to top-0 everywhere there's no inset. */}
      <header className="sticky top-[env(safe-area-inset-top)] z-40 hidden border-b border-hairline bg-material backdrop-blur-[20px] md:block">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-8 py-3">
          <div className="flex items-center gap-7">
            <Link href="/" className="text-[17px] font-bold tracking-tight text-ink">
              Obsidian-X
            </Link>
            <nav className="flex items-center gap-1">
              {PRIMARY.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={isActive(l.href) ? "page" : undefined}
                  className={`inline-flex items-center gap-1.5 rounded-[10px] px-3.5 py-1.5 text-[13px] transition ${
                    isActive(l.href)
                      ? "bg-white/[0.08] font-semibold text-ink"
                      : "font-medium text-ink-2 hover:text-ink"
                  }`}
                >
                  {l.label}
                  {l.badge && <Badge n={badgeCount(l.badge)} />}
                </Link>
              ))}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMoreOpen((v) => !v)}
                  aria-expanded={moreOpen}
                  aria-haspopup="menu"
                  className={`inline-flex items-center gap-1.5 rounded-[10px] px-3.5 py-1.5 text-[13px] transition ${
                    moreActive || moreOpen
                      ? "bg-white/[0.08] font-semibold text-ink"
                      : "font-medium text-ink-2 hover:text-ink"
                  }`}
                >
                  More
                  <span className={`text-[9px] leading-none transition ${moreOpen ? "rotate-180" : ""}`}>
                    ▾
                  </span>
                </button>
                {moreOpen && (
                  <div
                    role="menu"
                    className="absolute left-0 top-full z-50 mt-2 w-60 rounded-card border border-hairline-2 bg-material-2 p-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.5)] backdrop-blur-[20px]"
                  >
                    {moreItems}
                  </div>
                )}
              </div>
            </nav>
          </div>
          {email && <span className="max-w-[220px] truncate text-[13px] text-ink-3">{email}</span>}
        </div>
      </header>
      {/* Click-away catcher for the desktop menu — under the menu, over the page. */}
      {moreOpen && (
        <div className="fixed inset-0 z-30 hidden md:block" onClick={() => setMoreOpen(false)} aria-hidden />
      )}

      {/* Mobile — bottom tab bar + More sheet */}
      {!hideMobileBar && moreOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setMoreOpen(false)}>
          <div
            role="menu"
            className="obx-safe-x absolute inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom))] rounded-card border border-hairline-2 bg-material-2 p-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.5)] backdrop-blur-[20px]"
            onClick={(e) => e.stopPropagation()}
          >
            {moreItems}
          </div>
        </div>
      )}
      <nav
        aria-label="Primary"
        className={`obx-safe-x fixed inset-x-0 bottom-0 z-50 grid-cols-5 border-t border-hairline bg-material pb-[calc(6px+env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-[20px] md:hidden ${
          hideMobileBar ? "hidden" : "grid"
        }`}
      >
        {PRIMARY.map((t) => {
          const active = isActive(t.href);
          const n = badgeCount(t.badge);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className="relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-control"
              style={{ color: active ? "#9db2ff" : "rgba(255,255,255,0.45)" }}
            >
              <Icon path={ICONS[t.icon]} active={active} />
              <span className="text-[10px] font-semibold leading-none">{t.label}</span>
              {t.badge && n > 0 && (
                <span className="pointer-events-none absolute right-[20%] top-0.5">
                  <Badge n={n} />
                </span>
              )}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          className="flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-control"
          style={{ color: moreActive || moreOpen ? "#9db2ff" : "rgba(255,255,255,0.45)" }}
        >
          <Icon path={ICONS.more} active={moreActive || moreOpen} />
          <span className="text-[10px] font-semibold leading-none">More</span>
        </button>
      </nav>
    </>
  );
}
