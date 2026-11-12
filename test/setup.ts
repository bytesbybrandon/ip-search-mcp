// Tests run without credentials wherever they run: clear provider keys and
// never read keys from the Windows user environment.
process.env.IP_WINDOWS_ENV = "0";
for (const name of ["USPTO_ODP_API_KEY", "USPTO_TSDR_API_KEY", "EPO_OPS_CLIENT_ID", "EPO_OPS_CLIENT_SECRET", "OPENALEX_API_KEY", "GITHUB_TOKEN"]) {
  delete process.env[name];
}
