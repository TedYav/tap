// Test-only frontmatter read through the native envelope owner.
import { envelopeField, readEnvelopeHeader } from "../../src/envelope";
const [path, key] = process.argv.slice(2);
if (!path || !key) throw new Error("envelope-field fixture needs path and key");
const value = envelopeField(readEnvelopeHeader(path), key);
if (value !== undefined) process.stdout.write(value + "\n");
