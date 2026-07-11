export type CallStatus = "new" | "accepted" | "done" | "cancelled";
export type ShiftStatus = "checklist" | "active" | "ended";
export type AdminAccessRole = "admin" | "owner";
export type StaffRoleKind = "owner" | "admin" | "waiter" | "staff";
export type CallRoutingStage = "waiter" | "admin" | "owner";

export type StaffRoleDefinition = {
  id: string;
  name: string;
  kind: StaffRoleKind;
  system: boolean;
  active: boolean;
};

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
  roleId: string;
  telegramChatId: string;
  tipUrl: string;
  active: boolean;
};

export type ChecklistItem = {
  id: string;
  roleId: string;
  title: string;
  description: string;
  requiredForCalls: boolean;
  countsForRating: boolean;
  active: boolean;
  sort: number;
};

export type ShiftTask = {
  id: string;
  roleId: string;          // должность (для фильтрации "все сотрудники роли")
  waiterId: string | null; // конкретный сотрудник, null = все сотрудники роли
  date: string;            // YYYY-MM-DD — дата смены, когда задание активно
  title: string;
  description: string;
  requiredForCalls: boolean;
  countsForRating: boolean;
  notified: boolean;       // уже отправлено персональное уведомление
  createdAt: string;
};

export type ShiftChecklistEntry = {
  itemId: string;
  title: string;
  description: string;
  requiredForCalls: boolean;
  countsForRating: boolean;
  sort: number;
  completedAt: string | null;
  adminScore: number | null;
  adminComment: string;
};

export type WaiterShift = {
  id: string;
  waiterId: string;
  waiterName: string;
  roleId: string;
  roleName: string;
  roleKind: StaffRoleKind;
  zones: string[];
  status: ShiftStatus;
  checklist: ShiftChecklistEntry[];
  score: number;
  startedAt: string;
  readyAt: string | null;
  endedAt: string | null;
  morningGreetingDate: string;
};

export type WaiterRating = {
  waiterId: string;
  waiterName: string;
  roleId: string;
  roleName: string;
  roleKind: StaffRoleKind;
  score: number;
  totalStars: number;
  ratedTaskCount: number;
  completedRatedTaskCount: number;
  completionRate: number;
  trend: number;
  shiftCount: number;
  rank: number;
};

export type RolePerformanceSummary = {
  roleId: string;
  roleName: string;
  employeeCount: number;
  ratedShiftCount: number;
  averageStars: number;
  completionRate: number;
};

export type TaskPerformancePattern = {
  key: string;
  roleId: string;
  roleName: string;
  taskTitle: string;
  countsForRating: boolean;
  assignments: number;
  completed: number;
  missed: number;
  lowRatings: number;
  averageStars: number | null;
  issueRate: number;
  affectedEmployees: number;
};

export type EmployeePerformancePattern = {
  key: string;
  waiterId: string;
  waiterName: string;
  roleId: string;
  roleName: string;
  taskTitle: string;
  countsForRating: boolean;
  assignments: number;
  missed: number;
  lowRatings: number;
  averageStars: number | null;
  issueRate: number;
  recommendation: string;
};

export type PerformanceAnalytics = {
  generatedAt: string;
  analyzedShiftCount: number;
  roleSummaries: RolePerformanceSummary[];
  taskPatterns: TaskPerformancePattern[];
  employeePatterns: EmployeePerformancePattern[];
  recommendations: string[];
};

export type EmployeePerformanceAdvice = {
  waiterId: string;
  advice: string;
};

export type PerformanceInsightReport = {
  generatedAt: string;
  source: "openrouter" | "rules";
  model: string;
  summary: string;
  recommendations: string[];
  employeeAdvice: EmployeePerformanceAdvice[];
  warning: string;
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
  recipientRole: "waiter" | "admin" | "owner" | "unknown";
  kind: "call" | "warning";
};

export type CallReasonCount = {
  actionId: string;
  label: string;
  count: number;
};

export type ServiceCall = {
  id: string;
  threadVersion: number;
  tableId: string;
  actionId: string;
  actionLabel: string;
  comment: string;
  guestName: string;
  status: CallStatus;
  assignedWaiterId: string | null;
  acceptedByWaiterId: string | null;
  lastAcceptedByWaiterId: string | null;
  acceptedByStaffId: string | null;
  lastAcceptedByStaffId: string | null;
  routingStage: CallRoutingStage;
  routingReason: string;
  adminEscalationStartedAt: string | null;
  adminWarningSentAt: string | null;
  ownerEscalatedAt: string | null;
  pressCount: number;
  reasonCounts: CallReasonCount[];
  cycleStartedAt: string;
  lastRequestedAt: string;
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

export type PopupNotification = {
  id: string;
  title: string;
  body: string;
  imageUrl: string;
  buttonText: string;
  buttonUrl: string;
  active: boolean;
  sort: number;
  createdAt: string;
};

export type AppData = {
  settings: VenueSettings;
  offers: Offer[];
  actions: CallAction[];
  staffRoles: StaffRoleDefinition[];
  waiters: Waiter[];
  tables: DiningTable[];
  checklistItems: ChecklistItem[];
  shiftTasks: ShiftTask[];
  shifts: WaiterShift[];
  calls: ServiceCall[];
  loyaltyLeads: LoyaltyLead[];
  feedbacks: GuestFeedback[];
  popups: PopupNotification[];
  updatedAt: string;
};
