import { config } from "./config";

export type LoyaltyProfile = {
  userId: string;
  name: string;
  phoneMasked: string;
  iikoCustomerId: string | null;
  cardNumber: string | null;
  bonusBalance: number;
  balanceUpdatedAt: string | null;
  welcomeBonus: {
    amount: number;
    status: string;
    granted: boolean;
  };
};

type CrmResponse = {
  ok?: boolean;
  error?: string;
};

export type LoyaltyVerificationStart = {
  verificationId: string;
  expiresAt: string;
  channels: {
    telegram: { url: string } | null;
    max: { url: string } | null;
  };
};

export type LoyaltyVerificationStatus = {
  id: string;
  status: string;
  channel: string | null;
  expiresAt: string;
  verifiedAt: string | null;
};

export type LoyaltyRegistrationRequest = {
  sourceRegistrationId: string;
  verificationId: string;
  name: string;
  phone: string;
  birthday?: string;
  tableSlug?: string;
  personalDataConsent: {
    accepted: true;
    acceptedAt: string;
    documentVersion: string;
    documentUrl: string;
    documentHash: string;
  };
  marketingConsent: boolean;
  ipAddress?: string;
  userAgent?: string;
};

export class CrmLoyaltyService {
  configured() {
    return Boolean(config.CRM_BASE_URL && config.CRM_LOYALTY_SERVICE_SECRET.length >= 32);
  }

  async register(payload: LoyaltyRegistrationRequest) {
    const data = await this.request<{ profile: LoyaltyProfile }>("/api/integrations/loyalty/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return data.profile;
  }

  async getProfile(userId: string) {
    const data = await this.request<{ profile: LoyaltyProfile }>(
      `/api/integrations/loyalty/members/${encodeURIComponent(userId)}`,
      { method: "GET" },
    );
    return data.profile;
  }

  async startVerification(phone: string) {
    return this.request<LoyaltyVerificationStart>("/api/integrations/loyalty/verification/start", {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
  }

  async getVerification(verificationId: string) {
    const data = await this.request<{ verification: LoyaltyVerificationStatus }>(
      `/api/integrations/loyalty/verification/${encodeURIComponent(verificationId)}`,
      { method: "GET" },
    );
    return data.verification;
  }

  private async request<T>(path: string, options: RequestInit): Promise<T> {
    if (!this.configured()) {
      throw new Error("Интеграция с CRM пока не настроена");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`${config.CRM_BASE_URL.replace(/\/$/, "")}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-loyalty-service-secret": config.CRM_LOYALTY_SERVICE_SECRET,
          ...(options.headers || {}),
        },
      });
      const data = (await response.json().catch(() => ({}))) as T & CrmResponse;
      if (!response.ok) {
        throw new Error(data.error || `CRM вернула ошибку ${response.status}`);
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const crmLoyalty = new CrmLoyaltyService();
