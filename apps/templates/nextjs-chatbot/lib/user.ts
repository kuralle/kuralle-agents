import { cookies } from "next/headers";
import { generateUUID } from "@/lib/utils";

export const USER_ID_COOKIE = "kuralle-user-id";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export async function getUserId(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(USER_ID_COOKIE)?.value;
  if (existing) {
    return existing;
  }

  const userId = generateUUID();
  cookieStore.set(USER_ID_COOKIE, userId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return userId;
}
