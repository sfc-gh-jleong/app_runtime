import { FileSearch, History } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { InvoiceHistory } from "@/components/invoices/invoice-history"
import { InvoiceWorkbench } from "@/components/invoices/invoice-workbench"
import { StatsRow } from "@/components/invoices/stats-row"

export const dynamic = "force-dynamic"

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        eyebrow="Summit Outfitters · AI_EXTRACT"
        title="Invoice reconciliation"
        description="Upload a vendor invoice PDF, check the extracted values against ORDERS and ORDER_ITEMS, fix anything that is wrong, and approve it into Snowflake."
      />
      <StatsRow />
      <Tabs defaultValue="process" className="space-y-4">
        <TabsList>
          <TabsTrigger value="process" className="gap-1.5">
            <FileSearch className="h-4 w-4" /> Process invoice
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <History className="h-4 w-4" /> History
          </TabsTrigger>
        </TabsList>
        {/* forceMount keeps an in-progress review alive while browsing history */}
        <TabsContent value="process" forceMount className="data-[state=inactive]:hidden">
          <InvoiceWorkbench />
        </TabsContent>
        <TabsContent value="history">
          <InvoiceHistory />
        </TabsContent>
      </Tabs>
    </main>
  )
}
