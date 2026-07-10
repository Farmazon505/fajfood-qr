export type CallStatus = "new" | "accepted" | "done" | "cancelled";

export type TableTentConfig = {
  callToAction: string;
  footerText: string;
  bgImage: string;
  bgOpacity: number;
  textColor: string;
  qrColor: string;
  qrBgColor: string;
  qrScale: number;
};

export type VenueSettings = {
  name: string;
  tagline: string;
  description: string;
  address: string;
  phone: string;
  hours: string;
  wifi: string;
  logoUrl: string;
  heroImage: string;
  reviewUrl: string;
  loyaltyTitle: string;
  loyaltyText: string;
  primaryColor: string;
  accentColor: string;
  secondaryColor: string;
  backgroundColor: string;
  tableTentConfig?: TableTentConfig;
};

export type Offer = {
  id: string;
  title: string;
  description: string;
  badge: string;
  active: boolean;
};

export type CallAction = {
  id: string;
  label: string;
  description: string;
  emoji: string;
  active: boolean;
  sort: number;
};

export type Waiter = {
  id: string;
  name: string;
  telegramChatId: string;
  tipUrl: string;
  active: boolean;
};

export type DiningTable = {
  id: string;
  name: string;
  slug: string;
  zone: string;
  waiterId: string | null;
  waiterIds: string[];
  menuUrl?: string;
};

export type TelegramMessageRef = {
  chatId: string;
  messageId: number;
};

export type ServiceCall = {
  id: string;
  tableId: string;
  actionId: string;
  actionLabel: string;
  comment: string;
  guestName: string;
  status: CallStatus;
  assignedWaiterId: string | null;
  acceptedByWaiterId: string | null;
  telegramMessages: TelegramMessageRef[];
  createdAt: string;
  acceptedAt: string | null;
  doneAt: string | null;
};

export type LoyaltyLead = {
  id: string;
  name: string;
  phone: string;
  birthday: string;
  tableId: string | null;
  personalDataConsent: boolean;
  personalDataConsentVersion: string;
  personalDataConsentHash: string;
  personalDataConsentAcceptedAt: string;
  marketingConsent: boolean;
  consentIpAddress: string;
  consentUserAgent: string;
  accessTokenHash: string;
  verificationId: string | null;
  verificationExpiresAt: string | null;
  phoneVerificationChannel: string | null;
  phoneVerifiedAt: string | null;
  crmUserId: string | null;
  iikoCustomerId: string | null;
  cardNumber: string | null;
  bonusBalance: number;
  balanceUpdatedAt: string | null;
  welcomeBonusAmount: number;
  welcomeBonusStatus: string;
  syncError: string;
  createdAt: string;
  updatedAt: string;
};

export type GuestFeedback = {
  id: string;
  tableId: string | null;
  waiterId: string | null;
  rating: number;
  reasons: string[];
  liked: string;
  disliked: string;
  guestName: string;
  phone: string;
  reviewClickCount: number;
  reviewClickedAt: string | null;
  createdAt: string;
};

export type AppData = {
  settings: VenueSettings;
  offers: Offer[];
  actions: CallAction[];
  waiters: Waiter[];
  tables: DiningTable[];
  calls: ServiceCall[];
  loyaltyLeads: LoyaltyLead[];
  feedbacks: GuestFeedback[];
  updatedAt: string;
};
