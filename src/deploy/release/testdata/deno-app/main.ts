// Fixture for the Deno native-app build tests: a server that listens where the
// platform says (127.0.0.1 and $PORT), the way a deployed app has to.
const { HOSTNAME = "127.0.0.1", PORT = "8000" } = Deno.env.toObject();
Deno.serve(
  { hostname: HOSTNAME, port: Number(PORT) },
  () => new Response("hello from deno\n"),
);
