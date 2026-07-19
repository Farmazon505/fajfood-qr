import { config } from "./config";

export type CrmReservationStatus =
  | "PENDING"
  | "CONFIRMED"
  | "SEATED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "WAITLIST";

export type CrmStaffReservation = {
  id: string;
  isIikoExternal: boolean;
  guestName: string;
  guestPhone: string | null;
  guestsCount: number;
  date: string;
  duration: number;
  deposit: number;
  depositPaid: boolean;
  notes: string | null;
  guestNotes: string | null;
  tags: string[];
  status: CrmReservationStatus;
  source: string;
  responsible: string | null;
  tableId: string | null;
};

export type CrmStaffTable = {
  id: string;
  number: number;
  capacity: number;
  hall: string;
  posX: number;
  posY: number;
  shape: string;
  width: number;
  height: number;
  label: string | null;
  iikoTableId: string | null;
  iikoState: {
    online: boolean;
    occupied: boolean;
    activeOrder: { id: string; number: string; status: string; openedAt: string | null; sum: number | null } | null;
  };
  reservations: CrmStaffReservation[];
};

export type CrmStaffSnapshot = {
  date: string;
  halls: Array<{ key: string; name: string; emoji: string; color: string; order: number }>;
  tables: CrmStaffTable[];
  iikoSync: { online: boolean; syncedAt: string | null; errors: string[]; occupiedTables: number };
};

export class CrmReservationsError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "CrmReservationsError";
  }
}

export class CrmReservationsClient {
  constructor(
    private readonly baseUrl = config.CRM_BASE_URL,
    private readonly secret = config.CRM_STAFF_SERVICE_SECRET,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  enabled() {
    return Boolean(this.baseUrl && this.secret.length >= 32);
  }

  async getSnapshot(date: string) {
    return this.request<CrmStaffSnapshot>(`?date=${encodeURIComponent(date)}`);
  }

  async updateReservation(input: {
    id: string;
    actor: string;
    status?: CrmReservationStatus;
    tableId?: string;
    notes?: string;
    reason?: string;
  }) {
    return this.request<{ success: true; reservation: CrmStaffReservation }>("", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  private async request<T>(suffix: string, init: RequestInit = {}) {
    if (!this.enabled()) throw new CrmReservationsError("Интеграция с CRM не настроена", 503);
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, "")}/api/integrations/qrnastol/staff-reservations${suffix}`,
      {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-qrnastol-staff-secret": this.secret,
          ...(init.headers || {}),
        },
      }
    );
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new CrmReservationsError(String(body.error || `CRM вернула HTTP ${response.status}`), response.status);
    }
    return body as T;
  }
}
