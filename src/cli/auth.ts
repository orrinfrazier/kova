// `kova auth` subcommand — manage credentials for AI providers that don't use
// per-token API keys. Today this is just ChatGPT/Codex subscription billing;
// future providers (Gemini Code Assist, Claude Max) plug in here.

import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { defaultCodexCredentialsPath, loginBrowser, loginHeadless, readCodexCredentials } from '../auth/codex/index.js';
import { log } from '../utils/logger.js';

/** Open `url` in the system default browser, best-effort. Falls back to
 *  printing if no opener is available. */
function openInBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${url.replace(/"/g, '\\"')}"`, (err) => {
    if (err) log.debug(`Could not auto-open browser: ${err.message}`);
  });
}

/** Run `kova auth login --codex`. Default is the browser flow; --headless uses
 *  device-code (SSH-friendly). Persists credentials at ~/.kova/auth/openai.json. */
export async function authLoginCodex(opts: { headless?: boolean } = {}): Promise<void> {
  if (opts.headless) {
    const creds = await loginHeadless({
      userAgent: `kova/${process.env.npm_package_version ?? '0'} (${platform()})`,
    });
    log.info(
      `Codex login complete. Credentials at ${defaultCodexCredentialsPath()}` +
        (creds.accountId ? ` (account: ${creds.accountId})` : ''),
    );
    return;
  }

  const creds = await loginBrowser({
    presentUrl: (url) => {
      process.stderr.write(
        `\nOpening browser for ChatGPT login. If it does not open automatically:\n\n  ${url}\n\nWaiting for callback…\n`,
      );
      openInBrowser(url);
    },
  });
  log.info(
    `Codex login complete. Credentials at ${defaultCodexCredentialsPath()}` +
      (creds.accountId ? ` (account: ${creds.accountId})` : ''),
  );
}

/** Print the current Codex login state. Exits 1 if no credentials present. */
export function authStatusCodex(): void {
  let creds: ReturnType<typeof readCodexCredentials>;
  try {
    creds = readCodexCredentials();
  } catch (e) {
    log.error(
      `Codex credentials at ${defaultCodexCredentialsPath()} are malformed: ${e instanceof Error ? e.message : e}`,
    );
    process.exit(1);
  }
  if (!creds) {
    console.log(`Not logged in. Run \`kova auth login --codex\` to authorize.`);
    process.exit(1);
  }
  const remainingSec = Math.max(0, Math.floor((creds.expires - Date.now()) / 1000));
  console.log(
    `Logged in to ChatGPT (Codex).` +
      (creds.accountId ? `\n  account: ${creds.accountId}` : '') +
      `\n  file:    ${defaultCodexCredentialsPath()}` +
      `\n  expires: ${new Date(creds.expires).toISOString()} (${remainingSec}s remaining; auto-refresh on next \`kova fix\`)`,
  );
}
