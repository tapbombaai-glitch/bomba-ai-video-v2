import { supabase } from "../../../../lib/supabase";
import { randomBytes } from "crypto";

export async function POST(req) {
  try {
    /*
     * =====================================================
     * 1. GET AUTHENTICATED USER
     * =====================================================
     *
     * The user's Supabase access token must be sent as:
     *
     * Authorization: Bearer <access_token>
     *
     * We NEVER use email as the ownership mechanism.
     */

    const authorization =
      req.headers.get("authorization") || "";

    if (
      !authorization.startsWith("Bearer ")
    ) {
      return Response.json(
        {
          error:
            "Authentication is required.",
        },
        { status: 401 }
      );
    }

    const accessToken =
      authorization.replace(
        "Bearer ",
        ""
      ).trim();

    if (!accessToken) {
      return Response.json(
        {
          error:
            "Authentication token is missing.",
        },
        { status: 401 }
      );
    }

    const {
      data: {
        user,
      },
      error: authError,
    } =
      await supabase.auth.getUser(
        accessToken
      );

    if (authError || !user) {
      console.error(
        "BOMBA AUTH ERROR:",
        authError
      );

      return Response.json(
        {
          error:
            "Your session is invalid or has expired.",
        },
        { status: 401 }
      );
    }

    /*
     * =====================================================
     * 2. USER ID IS THE REAL OWNER
     * =====================================================
     */

    const userId = user.id;

    const email =
      typeof user.email === "string"
        ? user.email.trim().toLowerCase()
        : "";

    if (!email) {
      return Response.json(
        {
          error:
            "Your account does not have an email address.",
        },
        { status: 400 }
      );
    }

    /*
     * =====================================================
     * 3. FIND ONLY THIS USER'S BOMBA KEY
     * =====================================================
     *
     * IMPORTANT:
     * We search by user_id, NOT by email.
     */

    const {
      data: existingKey,
      error: lookupError,
    } = await supabase
      .from("bomba_keys")
      .select(
        "key_code, videos_allowed, videos_used"
      )
      .eq("user_id", userId)
      .maybeSingle();

    if (lookupError) {
      console.error(
        "BOMBA API KEY LOOKUP ERROR:",
        lookupError
      );

      return Response.json(
        {
          error:
            "Unable to check your BOMBA API Key.",
        },
        { status: 500 }
      );
    }

    /*
     * =====================================================
     * 4. EXISTING KEY
     * =====================================================
     */

    if (existingKey) {
      const allowed =
        Number(
          existingKey.videos_allowed
        ) || 0;

      const used =
        Number(
          existingKey.videos_used
        ) || 0;

      return Response.json({
        success: true,
        key: existingKey.key_code,
        videos_allowed: allowed,
        videos_used: used,
        remaining_videos: Math.max(
          0,
          allowed - used
        ),
        message:
          "You already have a BOMBA API Key.",
      });
    }

    /*
     * =====================================================
     * 5. GENERATE SECURE BOMBA KEY
     * =====================================================
     */

    const key_code =
      "bomba_" +
      randomBytes(32).toString("hex");

    /*
     * =====================================================
     * 6. CREATE USER-OWNED KEY
     * =====================================================
     */

    const {
      data,
      error,
    } = await supabase
      .from("bomba_keys")
      .insert([
        {
          user_id: userId,
          email,
          key_code,
          videos_allowed: 3,
          videos_used: 0,
        },
      ])
      .select(
        "key_code, videos_allowed, videos_used"
      )
      .single();

    if (error) {
      console.error(
        "BOMBA API KEY CREATE ERROR:",
        error
      );

      return Response.json(
        {
          error:
            "Failed to create your BOMBA API Key.",
        },
        { status: 500 }
      );
    }

    /*
     * =====================================================
     * 7. RETURN USER'S KEY
     * =====================================================
     */

    const allowed =
      Number(
        data.videos_allowed
      ) || 0;

    const used =
      Number(
        data.videos_used
      ) || 0;

    return Response.json({
      success: true,

      key:
        data.key_code,

      videos_allowed:
        allowed,

      videos_used:
        used,

      remaining_videos:
        Math.max(
          0,
          allowed - used
        ),

      message:
        "BOMBA API Key created successfully. You have 3 free video generations.",
    });
  } catch (error) {
    console.error(
      "BOMBA API KEY ERROR:",
      error
    );

    return Response.json(
      {
        error:
          error?.message ||
          "Unable to create BOMBA API Key.",
      },
      { status: 500 }
    );
  }
}
