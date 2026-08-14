"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { COURSE_PASS_THRESHOLD, COURSE_QUESTIONS, scoreCourse } from "@/lib/course";
import type { LocationState, PayrollClass, RoleType } from "@/lib/types/database";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export async function updatePaProfile(formData: FormData) {
  const { supabase, user } = await requireUser();

  const homeState = String(formData.get("home_state") ?? "") as LocationState;
  const bio = String(formData.get("bio") ?? "");
  const yearsExperience = Number(formData.get("years_experience") ?? 0);
  const payrollClass = String(formData.get("payroll_class") ?? "") as PayrollClass;
  const roleTypes = formData.getAll("role_types").map(String) as RoleType[];

  const { error } = await supabase.from("pa_profiles").upsert({
    profile_id: user.id,
    home_state: homeState || null,
    bio: bio || null,
    years_experience: Number.isFinite(yearsExperience) ? yearsExperience : 0,
    payroll_class: payrollClass || null,
    role_types: roleTypes,
  });

  if (error) {
    redirect(`/pa/onboarding?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/pa/onboarding");
  revalidatePath("/pa/dashboard");
  redirect("/pa/onboarding?saved=1");
}

export async function uploadTaxDoc(formData: FormData) {
  const { supabase, user } = await requireUser();

  const file = formData.get("tax_doc");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/pa/onboarding?error=Choose a file first");
  }

  const path = `${user.id}/${Date.now()}-${(file as File).name}`;
  const { error: uploadError } = await supabase.storage
    .from("tax-docs")
    .upload(path, file as File, { upsert: true });

  if (uploadError) {
    redirect(`/pa/onboarding?error=${encodeURIComponent(uploadError.message)}`);
  }

  const { error } = await supabase
    .from("pa_profiles")
    .update({ tax_residency_doc_path: path, tax_residency_status: "pending" })
    .eq("profile_id", user.id);

  if (error) {
    redirect(`/pa/onboarding?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/pa/onboarding");
  redirect("/pa/onboarding?doc_uploaded=1");
}

export async function submitCourse(formData: FormData) {
  const { supabase, user } = await requireUser();

  const answers: Record<string, number> = {};
  for (const q of COURSE_QUESTIONS) {
    const raw = formData.get(q.id);
    if (raw !== null) answers[q.id] = Number(raw);
  }

  const score = scoreCourse(answers);
  const passed = score / 100 >= COURSE_PASS_THRESHOLD;

  const { error } = await supabase
    .from("pa_profiles")
    .update({
      course_score: score,
      course_completed_at: passed ? new Date().toISOString() : null,
    })
    .eq("profile_id", user.id);

  if (error) {
    redirect(`/pa/onboarding?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/pa/onboarding");
  redirect(`/pa/onboarding?course_score=${score}`);
}
