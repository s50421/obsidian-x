import { createClient } from "@supabase/supabase-js";

// Server-only admin client using the service_role key. Bypasses RLS.
// NEVER import this into a client component.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
