export function extractCommand(text, useFilter, commandPrefix) {
    if (!useFilter)
        return text.trim();
    if (!text.startsWith(commandPrefix))
        return null;
    const remainder = text.slice(commandPrefix.length);
    if (remainder.length > 0 && !/^[\s:\-]/u.test(remainder))
        return null;
    return remainder.replace(/^[\s:\-]+/u, "").trim();
}
