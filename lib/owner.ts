// Single-user gate. The app is usable only by OWNER_EMAIL.

export function ownerEmail(): string {
  return (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
}

export function isOwner(email: string | null | undefined): boolean {
  const owner = ownerEmail();
  if (!owner) return false; // no owner configured => nobody is allowed
  return (email ?? "").trim().toLowerCase() === owner;
}
