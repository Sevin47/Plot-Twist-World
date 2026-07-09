import { createClient } from "@supabase/supabase-js";

/*
  Single shared Supabase client for the whole app: real accounts (Google
  sign-in) plus the server-validated economy RPCs in supabase.sql. There is
  no anonymous/local-only mode anymore — accounts are mandatory, so without
  VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY configured the game simply can't
  start (see the "unconfigured" state in PlotTwistWorld.jsx).
*/

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const MULTIPLAYER = !!(url && anon);
export const supabase = MULTIPLAYER ? createClient(url, anon) : null;
