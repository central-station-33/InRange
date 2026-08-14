"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { TaxResidencyStatus } from "@/lib/types/database";

export async function setTaxResidencyStatus(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const paId = String(formData.get("pa_id") ?? "");
  const status = String(formData.get("status") ?? "") as TaxResidencyStatus;
  const notes = String(formData.get("notes") ?? "");

  const { error } = await supabase
    .from("pa_profiles")
    .update({ tax_residency_status: status, admin_notes: notes || null })
    .eq("profile_id", paId);

  revalidatePath("/admin");

  if (error) {
    redirect(`/admin?error=${encodeURIComponent(error.message)}`);
  }
  redirect("/admin?updated=1");
}

export async function getTaxDocUrl(path: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from("tax-docs").createSignedUrl(path, 60 * 5);
  if (error) return null;
  return data.signedUrl;
}
