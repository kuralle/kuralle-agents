/** Customer consent for outbound messaging (RFC §4.7 / REQ-11, REQ-19). */
export interface ConsentStore {
  isOptedIn(customerId: string): Promise<boolean>;
  optOut(customerId: string): Promise<void>;
  optIn(customerId: string): Promise<void>;
}
