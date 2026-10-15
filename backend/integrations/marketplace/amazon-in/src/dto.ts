/**
 * Amazon Selling Partner API (SP-API) wire types: ONLY what this connector uses. They never leave this package;
 * mappers.ts converts them to the platform's normalised models.
 * Modeled on the public SP-API documentation (LWA, Orders v0, Listings Items 2021-08-01, Product Type Definitions 2020-09-01).
 */
export interface LwaTokenResponse { access_token: string; refresh_token?: string; token_type: 'bearer'; expires_in: number }
export interface LwaError { error: string; error_description?: string }

export interface AmzMoney { CurrencyCode: string; Amount: string }

export type AmzOrderStatus =
  | 'PendingAvailability' | 'Pending' | 'Unshipped' | 'PartiallyShipped' | 'Shipped' | 'InvoiceUnconfirmed' | 'Canceled' | 'Unfulfillable';

export interface AmzAddress { Name?: string; AddressLine1?: string; AddressLine2?: string; City?: string; StateOrRegion?: string; PostalCode?: string; CountryCode?: string; Phone?: string }

export interface AmzOrder {
  AmazonOrderId: string;
  PurchaseDate: string;
  LastUpdateDate: string;
  OrderStatus: AmzOrderStatus;
  OrderTotal?: AmzMoney;
  PaymentMethod?: 'COD' | 'CVS' | 'Other';
  FulfillmentChannel?: 'AFN' | 'MFN';
  BuyerInfo?: { BuyerEmail?: string; BuyerName?: string };
  ShippingAddress?: AmzAddress;
  MarketplaceId?: string;
}

export interface AmzOrderItem {
  ASIN?: string;
  SellerSKU: string;
  OrderItemId: string;
  Title?: string;
  QuantityOrdered: number;
  QuantityShipped?: number;
  ItemPrice?: AmzMoney;
  ItemTax?: AmzMoney;
  PromotionDiscount?: AmzMoney;
}

export interface AmzOrdersPage { payload: { Orders: AmzOrder[]; NextToken?: string } }
export interface AmzOrderItemsPage { payload: { AmazonOrderId: string; OrderItems: AmzOrderItem[] } }

export interface AmzIssue { code: string; message: string; severity: 'ERROR' | 'WARNING' | 'INFO'; attributeNames?: string[] }

export interface AmzListingsItem {
  sku: string;
  summaries?: Array<{ marketplaceId: string; asin?: string; productType?: string; status: string[]; itemName?: string; createdDate?: string; lastUpdatedDate?: string }>;
  attributes?: Record<string, Array<{ value?: unknown; marketplace_id?: string; language_tag?: string }>>;
  issues?: AmzIssue[];
  offers?: Array<{ marketplaceId: string; offerType: 'B2C' | 'B2B'; price: { currencyCode: string; amount: string } }>;
  fulfillmentAvailability?: Array<{ fulfillmentChannelCode: string; quantity: number }>;
}

export interface AmzListingsSearchPage { numberOfResults: number; pagination?: { nextToken?: string }; items: AmzListingsItem[] }
export interface AmzSubmission { sku: string; status: 'ACCEPTED' | 'INVALID' | 'VALID'; submissionId: string; issues: AmzIssue[] }
export interface AmzProductTypeSearch { productTypes: Array<{ name: string; displayName: string; marketplaceIds: string[] }> }

export interface AmzMarketplaceParticipation {
  marketplace: { id: string; countryCode: string; name: string; defaultCurrencyCode: string; defaultLanguageCode: string; domainName: string };
  participation: { isParticipating: boolean; hasSuspendedListings: boolean };
}

/** ORDER_CHANGE / LISTINGS_ITEM_STATUS_CHANGE notification envelope (delivered through SQS/EventBridge; see webhooks.ts) */
export interface AmzNotification {
  NotificationVersion: string;
  NotificationType: 'ORDER_CHANGE' | 'LISTINGS_ITEM_STATUS_CHANGE' | string;
  EventTime: string;
  NotificationMetadata: { ApplicationId: string; SubscriptionId: string; PublishTime: string; NotificationId: string };
  Payload: {
    OrderChangeNotification?: { AmazonOrderId: string; OrderStatus?: AmzOrderStatus };
    ListingsItemStatusChangeNotification?: { SellerId: string; Sku: string; Status: string[] };
  };
}
