import { supportConfig } from '../support.config';
import { publicSupportConfig } from '../src/config';
import { SupportChat } from './support-chat';

export default function SupportPage() {
  return (
    <SupportChat
      config={publicSupportConfig(supportConfig)}
      apiBaseUrl={process.env.NEXT_PUBLIC_SUPPORT_API_URL?.replace(/\/$/, '') || ''}
    />
  );
}
