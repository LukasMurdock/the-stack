// Passwords the server generates and hands to a person exactly once (a new
// user's starting password, the first administrator's password). Callers must
// never log or store the value; only Better Auth's hash is persisted.

const PASSWORD_ALPHABET =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

// Keeps generation well inside passwordSchema's 128-character maximum.
const GENERATED_PASSWORD_LENGTH_MAX = 64;

export function generatePassword(lengthChars: number): string {
	if (!Number.isInteger(lengthChars))
		throw new Error(
			"Invariant violated: password length must be an integer."
		);
	if (lengthChars < 16)
		throw new Error(
			"Invariant violated: generated passwords need 16+ characters."
		);
	if (lengthChars > GENERATED_PASSWORD_LENGTH_MAX)
		throw new Error("Invariant violated: generated password is too long.");
	const bytes = new Uint8Array(lengthChars);
	crypto.getRandomValues(bytes);
	let password = "";
	// 256 is a multiple of the 64-symbol alphabet, so there is no modulo bias.
	for (const byte of bytes)
		password += PASSWORD_ALPHABET.charAt(byte % PASSWORD_ALPHABET.length);
	return password;
}
