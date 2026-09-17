import { createClient } from "npm:@supabase/supabase-js@2";

const sha256_8 = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
};

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const secret = Deno.env.get("MAKE_WEBHOOK_SECRET") ?? "";
  const headerSent = req.headers.get("x-make-secret") ?? "";

  const out = {
    ran_at: new Date().toISOString(),
    env_secret_present: secret.length > 0,
    env_secret_len: secret.length,
    env_secret_hash8: secret ? await sha256_8(secret) : null,
    env_secret_first2: secret.slice(0, 2),
    env_secret_last2: secret.slice(-2),
    header_present: headerSent.length > 0,
    header_len: headerSent.length,
    header_hash8: headerSent ? await sha256_8(headerSent) : null,
    header_first2: headerSent.slice(0, 2),
    header_last2: headerSent.slice(-2),
    match: secret.length > 0 && secret === headerSent,
  };

  await supabase.from("raw_properties").upsert({
    property_hash: "diagnostic_secret_check",
    source: "diagnostic",
    raw_data: out,
    processed_at: new Date().toISOString(),
  }, { onConflict: "property_hash" });

  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});
