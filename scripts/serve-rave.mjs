/**
 * Sample deck on its own port. The tracker on 3840 is a different process.
 */
if (!process.env.PORT) process.env.PORT = "3870";
process.env.RAVE_UI = "1";
await import("../server.mjs");
