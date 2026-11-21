import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";


// testing for staging
// Next.js 16 renamed "middleware" to "proxy" (same functionality).
//
// This refreshes the Supabase session and bounces anonymous visitors to /login.
// It deliberately does NOT check roles — Prisma can't run on the Edge, and the DB
// is our source of truth for roles. The dashboard layout does the authoritative
// role/route check (src/app/(dashboard)/layout.tsx), and every server action is
// guarded by requireRole().
//
// It also forwards the pathname as a header, because server components don't
// receive the pathname and the layout needs it to enforce the route matrix.

const PUBLIC_PATHS = ["/login"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  // getUser() (not getSession) — it revalidates the token and refreshes cookies
  // through setAll above.
  const { data } = await supabase.auth.getUser();
  const signedIn = !!data.user;

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));

  // Only redirect page NAVIGATIONS. Server actions are POSTs to the current route;
  // redirecting one hands the client an HTML page instead of an action response
  // ("An unexpected response was received from the server"). Actions fall through
  // and are authorised by requireRole() instead.
  const isNavigation = request.method === "GET";

  if (isNavigation && !signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  if (isNavigation && signedIn && isPublic) {
    // Already signed in — the layout decides where they belong.
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  response.headers.set("x-pathname", pathname);
  return response;
}

export const config = {
  // Everything except Next internals, static assets and the API routes (which the
  // mobile app / uploads use with their own auth).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)"],
};
