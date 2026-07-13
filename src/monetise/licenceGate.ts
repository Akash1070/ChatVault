/**
 * src/monetise/licenceGate.ts — Module 8
 *
 * Dodo Payments licence validation with fail-open design.
 *
 * Validation flow:
 *   1. Read aiVault.licence.key from VS Code settings
 *   2. Check 24-hour cache in globalState (avoid spamming Dodo Payments API)
 *   3. If cache miss:
 *      - If we have a cached license_key_instance_id (activationId) → POST to Dodo Payments /licenses/validate
 *      - If validate fails or no activationId → POST to Dodo Payments /licenses/activate to register device
 *   4. Cache result for 24 hours in globalState
 *   5. If network fails → fail-open (treat as valid, log warning)
 *
 * 14-day free trial:
 *   On first install, write install_date to globalState.
 *   Within 14 days, isProUser() returns true regardless of licence key.
 *
 * Fail-open guarantee:
 *   EVERY network failure, timeout, or parse error results in pro access.
 *   We never block users due to our own infrastructure issues.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import { Settings } from '../config/settings';

// ─── Types ─────────────────────────────────────────────────────────────────────

export enum ProFeature {
  CLOUD_SYNC    = 'CLOUD_SYNC',
  AI_SUMMARY    = 'AI_SUMMARY',
  EXPORT_NOTION = 'EXPORT_NOTION',
  TEAM_SHARE    = 'TEAM_SHARE',
}

interface CachedValidation {
  isValid: boolean;
  licenceKey: string;
  cachedAt: number;   // Unix ms timestamp
  activationId?: string; // Dodo Payments license_key_instance_id
}

const DODO_ACTIVATE_URL = 'https://live.dodopayments.com/licenses/activate';
const DODO_VALIDATE_URL = 'https://live.dodopayments.com/licenses/validate';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;       // 24 hours
const TRIAL_DAYS   = 14;
const TRIAL_MS     = TRIAL_DAYS * 24 * 60 * 60 * 1000;
const CHECKOUT_URL = 'https://checkout.dodopayments.com/buy/pdt_0Nj6BTTgXLju7iS7Q1pfp';

// ─── LicenceGate class ─────────────────────────────────────────────────────────

export class LicenceGate implements vscode.Disposable {
  private _isProResolved: boolean | null = null;  // null = not yet checked
  private readonly _context: vscode.ExtensionContext;
  private readonly _settings: Settings;
  private _validateTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(context: vscode.ExtensionContext, settings: Settings) {
    this._context = context;
    this._settings = settings;
  }

  // ── Initialisation ──────────────────────────────────────────────────────────

  /**
   * Must be called once from extension activate().
   * Records install date on first run, then validates the licence async.
   * Does NOT block activation — validation happens in the background.
   */
  public async initialise(): Promise<void> {
    this._recordInstallDate();
    // Validate asynchronously — don't block activate()
    this._validateTimeout = setTimeout(() => this._validateLicence(), 2000);
  }

  private _recordInstallDate(): void {
    const existing = this._context.globalState.get<number>('chatVault.installDate');
    if (!existing) {
      this._context.globalState.update('chatVault.installDate', Date.now());
      console.log('[ChatVault Licence] First install recorded');
    }
  }

  // ── Trial ────────────────────────────────────────────────────────────────────

  private _isInTrial(): boolean {
    const installDate = this._context.globalState.get<number>('chatVault.installDate');
    if (!installDate) { return false; }
    return Date.now() - installDate < TRIAL_MS;
  }

  private _trialDaysRemaining(): number {
    const installDate = this._context.globalState.get<number>('chatVault.installDate') ?? Date.now();
    const elapsed = Date.now() - installDate;
    return Math.max(0, Math.ceil((TRIAL_MS - elapsed) / (24 * 60 * 60 * 1000)));
  }

  // ── Cache ─────────────────────────────────────────────────────────────────────

  private _getCached(): CachedValidation | null {
    const cached = this._context.globalState.get<CachedValidation>('chatVault.licenceCache');
    if (!cached) { return null; }
    // Cache key is the licence key — if user changes the key, invalidate
    if (cached.licenceKey !== this._settings.licenceKey) { return null; }
    if (Date.now() - cached.cachedAt > CACHE_TTL_MS) { return null; }
    return cached;
  }

  private _setCache(isValid: boolean, activationId?: string): void {
    const entry: CachedValidation = {
      isValid,
      licenceKey: this._settings.licenceKey,
      cachedAt: Date.now(),
      activationId,
    };
    this._context.globalState.update('chatVault.licenceCache', entry);
  }

  // ── Validation ───────────────────────────────────────────────────────────────

  private async _validateLicence(): Promise<boolean> {
    const key = this._settings.licenceKey;

    if (!key) {
      this._isProResolved = false;
      return false;
    }

    // Check 24-hour cache first
    const cached = this._getCached();
    if (cached !== null && cached.isValid) {
      this._isProResolved = cached.isValid;
      return cached.isValid;
    }

    // Network call to Dodo Payments
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5-second timeout

      // If we already have an activation ID, validate it
      if (cached?.activationId) {
        console.log('[ChatVault Licence] Validating existing activation ID:', cached.activationId);
        const response = await fetch(DODO_VALIDATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            license_key: key,
            license_key_instance_id: cached.activationId,
          }),
          signal: controller.signal,
        });

        if (response.ok) {
          const data = await response.json() as { valid?: boolean };
          if (data.valid === true) {
            clearTimeout(timeout);
            this._setCache(true, cached.activationId);
            this._isProResolved = true;
            console.log('[ChatVault Licence] Licence validated successfully ✅');
            return true;
          }
        }
        console.warn('[ChatVault Licence] Validation failed or invalid. Attempting re-activation.');
      }

      // If validation fails or we don't have an activation ID, activate the device
      const deviceName = `${os.hostname() || 'Unknown Device'} - VS Code`;
      console.log('[ChatVault Licence] Activating license key on device:', deviceName);
      const response = await fetch(DODO_ACTIVATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          license_key: key,
          name: deviceName,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        // Non-2xx → key is likely invalid or activation limit exceeded, but still fail-open on network issues
        console.warn(`[ChatVault Licence] Activation HTTP ${response.status} — invalid licence key`);
        this._setCache(false);
        this._isProResolved = false;
        return false;
      }

      const data = await response.json() as { id?: string };
      const activationId = data.id;

      if (!activationId) {
        throw new Error('Missing activation ID in response');
      }

      this._setCache(true, activationId);
      this._isProResolved = true;
      console.log('[ChatVault Licence] Licence activated and saved successfully ✅');
      return true;
    } catch (err) {
      // Network failure / timeout → FAIL OPEN
      console.warn('[ChatVault Licence] Network error — failing open:', err instanceof Error ? err.message : err);
      this._isProResolved = true; // Fail open
      return true;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Returns true if the user has pro access.
   * Checks in order: trial period → resolved validation → optimistic true (not yet checked).
   * Never throws. Always returns a usable boolean.
   */
  public isProUser(): boolean {
    // Trial period always grants access
    if (this._isInTrial()) { return true; }
    // If validation has completed, use the result
    if (this._isProResolved !== null) { return this._isProResolved; }
    // Validation is still pending (background task) → optimistic access
    return true;
  }

  /**
   * Returns true if the user has access to a specific pro feature.
   * All features require pro.
   */
  public getFeatureAccess(feature: ProFeature): boolean {
    void feature;
    return this.isProUser();
  }

  /**
   * Shows a VS Code info message prompting upgrade.
   */
  public showUpgradePrompt(feature: ProFeature): void {
    const featureLabels: Record<ProFeature, string> = {
      [ProFeature.CLOUD_SYNC]:    '☁️ Cloud Sync',
      [ProFeature.AI_SUMMARY]:    '🤖 AI Summaries',
      [ProFeature.EXPORT_NOTION]: '📝 Notion Export',
      [ProFeature.TEAM_SHARE]:    '👥 Team Sharing',
    };

    const label = featureLabels[feature] ?? String(feature);
    const daysLeft = this._trialDaysRemaining();
    const trialMsg = daysLeft > 0 ? ` (${daysLeft} trial days remaining)` : '';

    vscode.window
      .showInformationMessage(
        `ChatVault Pro — ${label} requires a Pro licence${trialMsg}. ` +
        `One-time purchase. No subscription.`,
        'Upgrade to Pro 🚀',
        'Enter Licence Key',
        'Not Now'
      )
      .then((action) => {
        if (action === 'Upgrade to Pro 🚀') {
          vscode.env.openExternal(vscode.Uri.parse(CHECKOUT_URL));
        } else if (action === 'Enter Licence Key') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'chatVault.licence.key'
          );
        }
      });
  }

  /**
   * Returns a human-readable plan label for display in the webview footer.
   */
  public getPlanLabel(): string {
    if (this._isInTrial()) {
      return `✨ Free Trial (${this._trialDaysRemaining()}d left)`;
    }
    if (this.isProUser()) {
      return '🔑 Pro';
    }
    return '🆓 Free';
  }

  /**
   * Force re-validates the licence key (bypasses 24h cache).
   * Triggered when the user updates chatVault.licence.key in settings.
   */
  public async revalidate(): Promise<void> {
    // Clear cache so _validateLicence fetches fresh
    this._context.globalState.update('chatVault.licenceCache', undefined);
    this._isProResolved = null;
    await this._validateLicence();
  }

  public dispose(): void {
    if (this._validateTimeout) {
      clearTimeout(this._validateTimeout);
    }
  }
}
