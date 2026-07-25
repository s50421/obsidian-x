"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Shared app chrome for the Apple-dark redesign: a slim translucent top nav on
// desktop and a bottom tab bar on mobile (Imports · Ops · Sign out tuck under
// "More"). Self-sufficient — fetches the owner email + pending-approvals badge
// from /api/me, so every page just drops in <AppNav />.

const LINKS: { href: string; label: string; badge?: boolean }[] = [
  { href: "/", label: "Home" },
  { href: "/graph", label: "Graph" },
  { href: "/interview", label: "Interview" },
  { href: "/imports", label: "Imports" },
  { href: "/approvals", label: "Approvals", badge: true },
  { href: "/ops", label: "Ops" },
];

const TABS: { href: string; label: string; icon: string; badge?: boolean }[] = [
  { href: "/", label: "Home", icon: "⌂" },
  { href: "/graph", label: "Graph", icon: "◎" },
  { href: "/interview", label: "Interview", icon: "✎" },
  { href: "/approvals", label: "Approvals", icon: "✓", badge: true },
];

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
      {n}
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
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d) {
          setEmail(d.email ?? "");
          setPending(d.pending ?? 0);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Re-close the More sheet on navigation.
  useEffect(() => setMoreOpen(false), [pathname]);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href);
  const moreActive = pathname === "/imports" || pathname === "/ops";

  return (
    <>
      {/* Desktop — slim translucent top nav */}
      <header className="sticky top-0 z-40 hidden border-b border-hairline bg-material backdrop-blur-[20px] md:block">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-8 py-3">
          <div className="flex items-center gap-7">
            <Link href="/" className="text-[17px] font-bold tracking-tight text-ink">
              Obsidian-X
            </Link>
            <nav className="flex items-center gap-1">
              {LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`inline-flex items-center gap-1.5 rounded-[10px] px-3.5 py-1.5 text-[13px] transition ${
                    isActive(l.href)
                      ? "bg-white/[0.08] font-semibold text-ink"
                      : "font-medium text-ink-2 hover:text-ink"
                  }`}
                >
                  {l.label}
                  {l.badge && <Badge n={pending} />}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            {email && <span className="text-[13px] text-ink-3">{email}</span>}
            <SignOut className="text-[13px] font-semibold text-ink-2 transition hover:text-ink" />
          </div>
        </div>
      </header>

      {/* Mobile — bottom tab bar + More sheet */}
      {!hideMobileBar && moreOpen && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setMoreOpen(false)}>
          <div
            className="absolute inset-x-3 bottom-[calc(72px+env(safe-area-inset-bottom))] rounded-card border border-hairline-2 bg-material-2 p-2 shadow-[0_16px_48px_rgba(0,0,0,0.5)] backdrop-blur-[20px]"
            onClick={(e) => e.stopPropagation()}
          >
            <Link
              href="/imports"
              className={`block rounded-control px-4 py-3 text-[15px] ${
                pathname === "/imports" ? "bg-white/[0.08] font-semibold text-ink" : "text-ink"
              }`}
            >
              Imports
            </Link>
            <Link
              href="/ops"
              className={`block rounded-control px-4 py-3 text-[15px] ${
                pathname === "/ops" ? "bg-white/[0.08] font-semibold text-ink" : "text-ink"
              }`}
            >
              Ops
            </Link>
            <SignOut className="block w-full rounded-control px-4 py-3 text-left text-[15px] text-danger" />
          </div>
        </div>
      )}
      <nav
        className={`fixed inset-x-0 bottom-0 z-50 grid-cols-5 border-t border-hairline bg-material px-2 pb-[calc(6px+env(safe-area-inset-bottom))] pt-2.5 backdrop-blur-[20px] md:hidden ${
          hideMobileBar ? "hidden" : "grid"
        }`}
      >
        {TABS.map((t) => {
          const active = isActive(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className="relative flex min-h-11 flex-col items-center gap-0.5"
              style={{ color: active ? "#9db2ff" : "rgba(255,255,255,0.45)" }}
            >
              <span className="text-xl leading-none">{t.icon}</span>
              <span className="text-[10px] font-semibold">{t.label}</span>
              {t.badge && pending > 0 && (
                <span className="absolute right-[24%] top-[-3px]">
                  <Badge n={pending} />
                </span>
              )}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className="flex min-h-11 flex-col items-center gap-0.5"
          style={{ color: moreActive || moreOpen ? "#9db2ff" : "rgba(255,255,255,0.45)" }}
        >
          <span className="text-xl leading-none">⋯</span>
          <span className="text-[10px] font-semibold">More</span>
        </button>
      </nav>
    </>
  );
}
