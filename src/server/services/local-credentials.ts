import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";

export const PASSWORD_HASH_PREFIX = "$forge$scrypt$";

const VERSION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
// OWASP's balanced scrypt profile for interactive authentication:
// N=2^15, r=8, p=3 (~32 MiB per derivation with additional CPU work).
const SCRYPT_P = 3;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 4096;

type ScryptParameters = { n: number; r: number; p: number };

const CURRENT_PARAMETERS: ScryptParameters = {
  n: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
};

function passwordBytes(password: string): number {
  return Buffer.byteLength(password, "utf8");
}

function assertHashablePassword(password: string): void {
  const bytes = passwordBytes(password);
  if (bytes === 0) throw new Error("Password must not be empty.");
  if (bytes > MAX_PASSWORD_BYTES) throw new Error("Password is too long.");
}

function deriveKey(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: parameters.n,
        r: parameters.r,
        p: parameters.p,
        maxmem: SCRYPT_MAXMEM,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function encodeHash(salt: Buffer, hash: Buffer, parameters: ScryptParameters): string {
  return [
    "",
    "forge",
    "scrypt",
    `v=${VERSION}`,
    `n=${parameters.n},r=${parameters.r},p=${parameters.p}`,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

type ParsedPasswordHash = {
  parameters: ScryptParameters;
  salt: Buffer;
  hash: Buffer;
};

function parseHash(encoded: string): ParsedPasswordHash | null {
  const parts = encoded.split("$");
  if (
    parts.length !== 7 ||
    parts[0] !== "" ||
    parts[1] !== "forge" ||
    parts[2] !== "scrypt" ||
    parts[3] !== `v=${VERSION}`
  ) {
    return null;
  }
  const match = /^n=(\d+),r=(\d+),p=(\d+)$/.exec(parts[4] ?? "");
  if (!match) return null;
  const parameters = {
    n: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
  };
  // Bound attacker-controlled parameters before handing them to scrypt.
  if (
    parameters.n < 2 ||
    parameters.n > SCRYPT_N ||
    (parameters.n & (parameters.n - 1)) !== 0 ||
    parameters.r < 1 ||
    parameters.r > SCRYPT_R ||
    parameters.p < 1 ||
    parameters.p > SCRYPT_P
  ) {
    return null;
  }
  try {
    const salt = Buffer.from(parts[5] ?? "", "base64url");
    const hash = Buffer.from(parts[6] ?? "", "base64url");
    if (salt.length < 16 || hash.length !== KEY_LENGTH) return null;
    return { parameters, salt, hash };
  } catch {
    return null;
  }
}

/** Hash a password with a fresh salt and the current versioned scrypt profile. */
export async function hashPassword(password: string): Promise<string> {
  assertHashablePassword(password);
  const salt = randomBytes(SALT_LENGTH);
  const hash = await deriveKey(password, salt, CURRENT_PARAMETERS);
  return encodeHash(salt, hash, CURRENT_PARAMETERS);
}

/** Verify a password against a Forge scrypt record. Malformed records fail closed. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (passwordBytes(password) > MAX_PASSWORD_BYTES) return false;
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  const actual = await deriveKey(password, parsed.salt, parsed.parameters);
  return timingSafeEqual(actual, parsed.hash);
}

const DUMMY_SALT = Buffer.from("forge-auth-dummy-salt-v1", "utf8");
let dummyHashPromise: Promise<string> | null = null;

function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= deriveKey("forge-invalid-password", DUMMY_SALT, CURRENT_PARAMETERS).then(
    (hash) => encodeHash(DUMMY_SALT, hash, CURRENT_PARAMETERS),
  );
  return dummyHashPromise;
}

/**
 * Always execute one valid scrypt derivation, even when no credential exists.
 * Callers should use this for sign-in to avoid account-enumeration timing.
 */
export async function verifyPasswordOrDummy(
  password: string,
  encoded: string | null | undefined,
): Promise<boolean> {
  const candidate = encoded && parseHash(encoded) ? encoded : await dummyPasswordHash();
  const matches = await verifyPassword(password, candidate);
  return Boolean(encoded) && matches;
}

/** True when a valid record uses a superseded parameter profile. */
export function needsPasswordRehash(encoded: string): boolean {
  const parsed = parseHash(encoded);
  return (
    !parsed ||
    parsed.parameters.n !== CURRENT_PARAMETERS.n ||
    parsed.parameters.r !== CURRENT_PARAMETERS.r ||
    parsed.parameters.p !== CURRENT_PARAMETERS.p
  );
}
