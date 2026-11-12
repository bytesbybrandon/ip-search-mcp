// Tests must see only the process environment: never read keys from the Windows user environment.
process.env.IP_WINDOWS_ENV = "0";
