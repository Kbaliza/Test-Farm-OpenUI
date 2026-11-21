import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { WhatsappClient } from "@/components/whatsapp/whatsapp-client";
import {
  getWhatsappStatus, getTemplates, getMessageLog, getRecipientsWithDues,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function WhatsappPage() {
  const status = await getWhatsappStatus();

  if (!status.dbReady) {
    return (
      <div className="flex flex-col">
        <PageHeader title="WhatsApp" description="Connect WhatsApp, manage templates and send messages" />
        <DbNotReady what="WhatsApp" />
      </div>
    );
  }

  const [{ templates }, { logs }, { recipients }] = await Promise.all([
    getTemplates(),
    getMessageLog(),
    getRecipientsWithDues(),
  ]);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="WhatsApp"
        description="Connect WhatsApp, manage message templates and send reminders"
      />
      <WhatsappClient
        initialStatus={status}
        initialTemplates={templates}
        initialLogs={logs}
        recipients={recipients}
      />
    </div>
  );
}
