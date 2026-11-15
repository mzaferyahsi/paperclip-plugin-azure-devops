const fs = require('fs'); const f = process.argv[2]; let s = fs.readFileSync(f, 'utf8');
const a = `            const resultRecord = result.result && typeof result.result === "object" && !Array.isArray(result.result)
                ? result.result
                : null;
            const contentText = typeof resultRecord?.content === "string"
                ? resultRecord.content
                : JSON.stringify(resultRecord?.data ?? result.result ?? null);
            res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: contentText }],
                    structuredContent: resultRecord?.data ?? null,
                    isError: false,
                },
            });`;
if (!s.includes(a)) { console.error('anchor not found: Paperclip changed this code; review by hand'); process.exit(1); }
const b = `            // ado-mcp-envelope-fix: unwrap the plugin dispatcher envelope; never emit structuredContent: null; map plugin errors to isError.
            const rawResult = result.result;
            const innerResult = rawResult && typeof rawResult === "object" && !Array.isArray(rawResult) && "pluginId" in rawResult && "result" in rawResult
                ? rawResult.result
                : rawResult;
            const resultRecord = innerResult && typeof innerResult === "object" && !Array.isArray(innerResult)
                ? innerResult
                : null;
            const pluginError = typeof resultRecord?.error === "string" ? resultRecord.error : null;
            const contentText = typeof resultRecord?.content === "string"
                ? (pluginError ? \`error \${pluginError}: \${resultRecord.content}\` : resultRecord.content)
                : JSON.stringify(resultRecord?.data ?? innerResult ?? null);
            const structured = resultRecord?.data && typeof resultRecord.data === "object" && !Array.isArray(resultRecord.data) ? resultRecord.data : null;
            res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: contentText }],
                    ...(structured ? { structuredContent: structured } : {}),
                    isError: pluginError !== null,
                },
            });`;
fs.writeFileSync(f, s.replace(a, b));
