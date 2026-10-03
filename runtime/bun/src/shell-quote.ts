/** POSIX single-quote one shell word, whatever it contains. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
