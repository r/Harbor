import { ChatApplication } from './integration/ChatApplication';
import type { ChatApplicationServices } from './integration/chat-application-services';

type AppProps = {
  services: ChatApplicationServices;
};

export function App({ services }: AppProps) {
  return <ChatApplication services={services} />;
}
