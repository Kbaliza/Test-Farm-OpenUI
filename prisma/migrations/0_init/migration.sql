-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'HALF_DAY', 'HOLIDAY');

-- CreateEnum
CREATE TYPE "BillingType" AS ENUM ('CREDIT', 'DAILY');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'RECOVERY', 'DISABLED');

-- CreateEnum
CREATE TYPE "FarmDispatchStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('PRODUCED', 'DISPATCHED', 'ARRIVED', 'HANDED_OVER', 'DELIVERED', 'RETURNED', 'WASTAGE', 'KITCHEN_USE', 'CALF_USE', 'REPLACEMENT', 'COUNTER_SALE', 'COUNTER_PURCHASE');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('CUSTOMER', 'HEAD', 'VENDOR', 'EMPLOYEE', 'EXPENSE_CATEGORY', 'PRODUCT');

-- CreateEnum
CREATE TYPE "NotePriority" AS ENUM ('NORMAL', 'HIGH', 'EXTREME');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SOLVED', 'TASK_COMPLETED');

-- CreateEnum
CREATE TYPE "NoteType" AS ENUM ('ORDER_CHANGE', 'TASK', 'COMPLAINT', 'TEMP_STOP', 'DESI_GHEE', 'REQUEST', 'NOTE', 'DESI_EGGS', 'BILL_ISSUE');

-- CreateEnum
CREATE TYPE "PaymentHead" AS ENUM ('RIDER_CASH', 'HBL', 'JAZZCASH', 'EASYPAISA', 'CASH');

-- CreateEnum
CREATE TYPE "ProductUnit" AS ENUM ('LITER', 'KG', 'PIECE');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('OVERDUE', 'MILK_DISABLED', 'IN_RECOVERY', 'CLEARED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'INVENTORY', 'RIDER', 'ACCOUNTANT', 'DOCTOR', 'PACKAGING', 'VAN_DRIVER');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "SampleStatus" AS ENUM ('ASSIGNED', 'DELIVERED', 'FOLLOWUP', 'CONVERTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('DAILY', 'ALTERNATE');

-- CreateEnum
CREATE TYPE "ShiftType" AS ENUM ('MORNING', 'EVENING', 'CUSTOM');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "reference" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Area" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "defaultDeliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customDates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scheduleAnchor" TEXT,
    "scheduleInterval" INTEGER NOT NULL DEFAULT 1,
    "scheduleType" TEXT NOT NULL DEFAULT 'DAILY',

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bonus" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT,

    CONSTRAINT "Bonus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Checklist" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "roleLabel" TEXT,
    "assigneeId" TEXT NOT NULL,
    "dueTime" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Checklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistCompletion" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChecklistCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "invoiceName" TEXT,
    "phone" TEXT NOT NULL,
    "secondPhone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "locationUrl" TEXT,
    "areaId" TEXT,
    "shiftId" TEXT,
    "riderId" TEXT,
    "billingType" "BillingType" NOT NULL DEFAULT 'CREDIT',
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "customerType" TEXT,
    "joinDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "creditLimit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deliveryInstructions" TEXT,
    "deliverySequence" INTEGER,
    "supabaseId" TEXT,
    "deactivationReason" TEXT,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerCalendarDay" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerCalendarDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerNotification" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "CustomerNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerOrder" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "forDate" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'ONE_DAY',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,

    CONSTRAINT "CustomerOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerProduct" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "ratePerUnit" DECIMAL(10,2) NOT NULL,
    "scheduleType" "ScheduleType" NOT NULL DEFAULT 'DAILY',
    "alternatePattern" DECIMAL(65,30)[] DEFAULT (ARRAY[]::numeric[])::numeric(65,30)[],
    "anchorDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyNote" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "NoteType" NOT NULL,
    "priority" "NotePriority" NOT NULL DEFAULT 'NORMAL',
    "status" "NoteStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "customerId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "authorName" TEXT,

    CONSTRAINT "DailyNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deduction" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT,

    CONSTRAINT "Deduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryEntry" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId" TEXT NOT NULL,
    "riderId" TEXT,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "unitRate" DECIMAL(10,2) NOT NULL,
    "isReturn" BOOLEAN NOT NULL DEFAULT false,
    "isReplacement" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "baseSalary" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "dailyWage" DECIMAL(10,2),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "head" "PaymentHead" NOT NULL,
    "description" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chitReceived" BOOLEAN NOT NULL DEFAULT false,
    "chitImageUrl" TEXT,
    "item" TEXT,
    "vendorId" TEXT,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "type" TEXT,
    "group" TEXT,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmDispatch" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declaredItems" JSONB NOT NULL,
    "receivedItems" JSONB,
    "status" "FarmDispatchStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FarmDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HeadTransfer" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromHead" "PaymentHead" NOT NULL,
    "toHead" "PaymentHead" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HeadTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "InventoryMovementType" NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "riderId" TEXT,
    "reason" TEXT,
    "reference" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stage" TEXT,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "prevBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deliveriesAmt" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "returnsAmt" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paymentsAmt" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalDue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "half" INTEGER NOT NULL DEFAULT 1,
    "periodEnd" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3),
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3),
    "callNotes" TEXT,
    "callNotesAt" TIMESTAMP(3),
    "billSentAt" TIMESTAMP(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "isReturn" BOOLEAN NOT NULL DEFAULT false,
    "isReplacement" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "area" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Total',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "LedgerKind" NOT NULL,
    "customerId" TEXT,
    "head" "PaymentHead",
    "vendorId" TEXT,
    "employeeId" TEXT,
    "productId" TEXT,
    "expenseCategoryId" TEXT,
    "description" TEXT,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "runningBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reference" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MixMilkBatch" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pktDate" TEXT,
    "buffaloMilk" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "cowMilk" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "mixMilkMade" DECIMAL(12,3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MixMilkBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyBudget" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "MonthlyBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteFollowup" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteFollowup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtcPurchase" (
    "id" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vendorId" TEXT NOT NULL,
    "narration" TEXT,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'PAID',
    "paymentHead" TEXT,
    "vendorBillId" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,

    CONSTRAINT "OtcPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtcPurchaseLine" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "OtcPurchaseLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtcSale" (
    "id" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerType" TEXT NOT NULL,
    "customerId" TEXT,
    "vendorId" TEXT,
    "cashName" TEXT,
    "deliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "narration" TEXT,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'PAID',
    "paymentHead" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vendorReceivableId" TEXT,

    CONSTRAINT "OtcSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtcSaleLine" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "OtcSaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "head" "PaymentHead" NOT NULL,
    "notes" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handedOverAt" TIMESTAMP(3),
    "handedToName" TEXT,
    "receivedAt" TIMESTAMP(3),
    "sampleId" TEXT,
    "riderId" TEXT,
    "receivedByName" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProof" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "screenshotUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "ProductUnit" NOT NULL DEFAULT 'LITER',
    "defaultRate" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT,
    "deliveryTime" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionLog" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shiftId" TEXT,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCase" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'OVERDUE',
    "daysOverdue" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "callStatus" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "visits" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecoveryCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryVisit" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetailDispatch" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vanDispatchId" TEXT,
    "declaredItems" JSONB NOT NULL,
    "receivedItems" JSONB,
    "status" "FarmDispatchStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "farmDispatchId" TEXT,

    CONSTRAINT "RetailDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rider" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vehicle" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "cnic" TEXT,

    CONSTRAINT "Rider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiderExtraItem" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "shiftId" TEXT NOT NULL,
    "riderId" TEXT,
    "productId" TEXT NOT NULL,
    "givenQty" DECIMAL(10,3) NOT NULL,
    "returnedQty" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OUT',
    "givenById" TEXT,
    "confirmedById" TEXT,
    "confirmedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiderExtraItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "shiftId" TEXT NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "RouteStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteStop" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "riderId" TEXT,
    "stopNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "cashCollected" DECIMAL(12,2),

    CONSTRAINT "RouteStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteStopItem" (
    "id" TEXT NOT NULL,
    "routeStopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "plannedQty" DECIMAL(10,3) NOT NULL,
    "actualQty" DECIMAL(10,3),

    CONSTRAINT "RouteStopItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryPayment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "head" "PaymentHead" NOT NULL,
    "notes" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleFollowup" (
    "id" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SampleFollowup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleItem" (
    "id" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "ratePerUnit" DECIMAL(10,2) NOT NULL DEFAULT 0,

    CONSTRAINT "SampleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleLead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "invoiceName" TEXT,
    "phone" TEXT NOT NULL,
    "secondPhone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "locationUrl" TEXT,
    "areaId" TEXT,
    "shiftId" TEXT,
    "status" "SampleStatus" NOT NULL DEFAULT 'ASSIGNED',
    "notes" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "convertedCustomerId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "supabaseId" TEXT,
    "scheduledDate" TIMESTAMP(3),

    CONSTRAINT "SampleLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ShiftType" NOT NULL DEFAULT 'MORNING',
    "startTime" TEXT,
    "riderId" TEXT,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkimMilkBatch" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "milkUsed" DECIMAL(12,3) NOT NULL,
    "cheeseMade" DECIMAL(12,3) NOT NULL,
    "skimMilkMade" DECIMAL(12,3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buffaloMilk" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "cowMilk" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "mixMilk" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "pktDate" TEXT,

    CONSTRAINT "SkimMilkBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "assigneeId" TEXT,
    "assigneeName" TEXT NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "priority" "NotePriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "authorName" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskFollowup" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskFollowup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL DEFAULT 'MANAGER',
    "passwordHash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "supabaseId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VanDispatch" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "farmDispatchId" TEXT NOT NULL,
    "declaredItems" JSONB NOT NULL,
    "receivedItems" JSONB,
    "status" "FarmDispatchStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VanDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorBill" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiptUrl" TEXT,

    CONSTRAINT "VendorBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorReceivable" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "received" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorReceivable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappMessageLog" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "templateId" TEXT,
    "phone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappMessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappSession" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "qr" TEXT,
    "connectedNumber" TEXT,
    "logoutRequested" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YoghurtBatch" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buffaloMilk" DECIMAL(12,3) NOT NULL,
    "cowMilk" DECIMAL(12,3) NOT NULL,
    "mixMilk" DECIMAL(12,3) NOT NULL,
    "boilingWaste" DECIMAL(12,3) NOT NULL,
    "yoghurtProduced" DECIMAL(12,3) NOT NULL,
    "productionWaste" DECIMAL(12,3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YoghurtBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ShiftAreas" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Area_name_key" ON "Area"("name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_employeeId_date_key" ON "Attendance"("employeeId" ASC, "date" ASC);

-- CreateIndex
CREATE INDEX "Checklist_assigneeId_idx" ON "Checklist"("assigneeId" ASC);

-- CreateIndex
CREATE INDEX "ChecklistCompletion_date_idx" ON "ChecklistCompletion"("date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistCompletion_itemId_date_key" ON "ChecklistCompletion"("itemId" ASC, "date" ASC);

-- CreateIndex
CREATE INDEX "ChecklistItem_checklistId_idx" ON "ChecklistItem"("checklistId" ASC);

-- CreateIndex
CREATE INDEX "Customer_areaId_idx" ON "Customer"("areaId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_customerCode_key" ON "Customer"("customerCode" ASC);

-- CreateIndex
CREATE INDEX "Customer_phone_idx" ON "Customer"("phone" ASC);

-- CreateIndex
CREATE INDEX "Customer_shiftId_idx" ON "Customer"("shiftId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_supabaseId_key" ON "Customer"("supabaseId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCalendarDay_customerId_date_key" ON "CustomerCalendarDay"("customerId" ASC, "date" ASC);

-- CreateIndex
CREATE INDEX "CustomerCalendarDay_date_idx" ON "CustomerCalendarDay"("date" ASC);

-- CreateIndex
CREATE INDEX "CustomerNotification_customerId_createdAt_idx" ON "CustomerNotification"("customerId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "CustomerOrder_customerId_forDate_idx" ON "CustomerOrder"("customerId" ASC, "forDate" ASC);

-- CreateIndex
CREATE INDEX "CustomerOrder_forDate_idx" ON "CustomerOrder"("forDate" ASC);

-- CreateIndex
CREATE INDEX "CustomerProduct_customerId_idx" ON "CustomerProduct"("customerId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProduct_customerId_productId_key" ON "CustomerProduct"("customerId" ASC, "productId" ASC);

-- CreateIndex
CREATE INDEX "DeliveryEntry_customerId_idx" ON "DeliveryEntry"("customerId" ASC);

-- CreateIndex
CREATE INDEX "DeliveryEntry_date_idx" ON "DeliveryEntry"("date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token" ASC);

-- CreateIndex
CREATE INDEX "device_token_customer_idx" ON "DeviceToken"("customerId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId" ASC);

-- CreateIndex
CREATE INDEX "Expense_categoryId_idx" ON "Expense"("categoryId" ASC);

-- CreateIndex
CREATE INDEX "Expense_date_idx" ON "Expense"("date" ASC);

-- CreateIndex
CREATE INDEX "Expense_vendorId_idx" ON "Expense"("vendorId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_name_key" ON "ExpenseCategory"("name" ASC);

-- CreateIndex
CREATE INDEX "InventoryMovement_date_idx" ON "InventoryMovement"("date" ASC);

-- CreateIndex
CREATE INDEX "InventoryMovement_productId_idx" ON "InventoryMovement"("productId" ASC);

-- CreateIndex
CREATE INDEX "InventoryMovement_type_idx" ON "InventoryMovement"("type" ASC);

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_customerId_month_year_half_key" ON "Invoice"("customerId" ASC, "month" ASC, "year" ASC, "half" ASC);

-- CreateIndex
CREATE INDEX "LedgerEntry_date_idx" ON "LedgerEntry"("date" ASC);

-- CreateIndex
CREATE INDEX "LedgerEntry_kind_customerId_idx" ON "LedgerEntry"("kind" ASC, "customerId" ASC);

-- CreateIndex
CREATE INDEX "LedgerEntry_kind_head_idx" ON "LedgerEntry"("kind" ASC, "head" ASC);

-- CreateIndex
CREATE INDEX "LedgerEntry_kind_vendorId_idx" ON "LedgerEntry"("kind" ASC, "vendorId" ASC);

-- CreateIndex
CREATE INDEX "MessageTemplate_active_idx" ON "MessageTemplate"("active" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_name_key" ON "MessageTemplate"("name" ASC);

-- CreateIndex
CREATE INDEX "MixMilkBatch_date_idx" ON "MixMilkBatch"("date" ASC);

-- CreateIndex
CREATE INDEX "MixMilkBatch_pktDate_idx" ON "MixMilkBatch"("pktDate" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyBudget_categoryId_month_year_key" ON "MonthlyBudget"("categoryId" ASC, "month" ASC, "year" ASC);

-- CreateIndex
CREATE INDEX "OtcPurchase_date_idx" ON "OtcPurchase"("date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "OtcPurchase_invoiceNo_key" ON "OtcPurchase"("invoiceNo" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "OtcPurchase_vendorBillId_key" ON "OtcPurchase"("vendorBillId" ASC);

-- CreateIndex
CREATE INDEX "OtcPurchase_vendorId_idx" ON "OtcPurchase"("vendorId" ASC);

-- CreateIndex
CREATE INDEX "OtcSale_customerId_idx" ON "OtcSale"("customerId" ASC);

-- CreateIndex
CREATE INDEX "OtcSale_date_idx" ON "OtcSale"("date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "OtcSale_invoiceNo_key" ON "OtcSale"("invoiceNo" ASC);

-- CreateIndex
CREATE INDEX "OtcSale_vendorId_idx" ON "OtcSale"("vendorId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "OtcSale_vendorReceivableId_key" ON "OtcSale"("vendorReceivableId" ASC);

-- CreateIndex
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId" ASC);

-- CreateIndex
CREATE INDEX "Payment_date_idx" ON "Payment"("date" ASC);

-- CreateIndex
CREATE INDEX "Payment_riderId_idx" ON "Payment"("riderId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_sampleId_head_key" ON "Payment"("sampleId" ASC, "head" ASC);

-- CreateIndex
CREATE INDEX "Payment_sampleId_idx" ON "Payment"("sampleId" ASC);

-- CreateIndex
CREATE INDEX "PaymentProof_customerId_idx" ON "PaymentProof"("customerId" ASC);

-- CreateIndex
CREATE INDEX "PaymentProof_status_idx" ON "PaymentProof"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Product_name_key" ON "Product"("name" ASC);

-- CreateIndex
CREATE INDEX "ProductionLog_date_idx" ON "ProductionLog"("date" ASC);

-- CreateIndex
CREATE INDEX "ProductionLog_productId_idx" ON "ProductionLog"("productId" ASC);

-- CreateIndex
CREATE INDEX "RecoveryCase_status_idx" ON "RecoveryCase"("status" ASC);

-- CreateIndex
CREATE INDEX "RecoveryVisit_caseId_idx" ON "RecoveryVisit"("caseId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "RetailDispatch_farmDispatchId_key" ON "RetailDispatch"("farmDispatchId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "RetailDispatch_vanDispatchId_key" ON "RetailDispatch"("vanDispatchId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Rider_userId_key" ON "Rider"("userId" ASC);

-- CreateIndex
CREATE INDEX "RiderExtraItem_date_idx" ON "RiderExtraItem"("date" ASC);

-- CreateIndex
CREATE INDEX "RiderExtraItem_productId_idx" ON "RiderExtraItem"("productId" ASC);

-- CreateIndex
CREATE INDEX "RiderExtraItem_shiftId_idx" ON "RiderExtraItem"("shiftId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Route_date_shiftId_key" ON "Route"("date" ASC, "shiftId" ASC);

-- CreateIndex
CREATE INDEX "RouteStop_routeId_idx" ON "RouteStop"("routeId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "SampleLead_convertedCustomerId_key" ON "SampleLead"("convertedCustomerId" ASC);

-- CreateIndex
CREATE INDEX "SampleLead_status_idx" ON "SampleLead"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "SampleLead_supabaseId_key" ON "SampleLead"("supabaseId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Shift_name_key" ON "Shift"("name" ASC);

-- CreateIndex
CREATE INDEX "SkimMilkBatch_date_idx" ON "SkimMilkBatch"("date" ASC);

-- CreateIndex
CREATE INDEX "SkimMilkBatch_pktDate_idx" ON "SkimMilkBatch"("pktDate" ASC);

-- CreateIndex
CREATE INDEX "Task_deadline_idx" ON "Task"("deadline" ASC);

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_supabaseId_key" ON "User"("supabaseId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "VanDispatch_farmDispatchId_key" ON "VanDispatch"("farmDispatchId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_name_key" ON "Vendor"("name" ASC);

-- CreateIndex
CREATE INDEX "WhatsappMessageLog_status_createdAt_idx" ON "WhatsappMessageLog"("status" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "YoghurtBatch_date_idx" ON "YoghurtBatch"("date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "_ShiftAreas_AB_unique" ON "_ShiftAreas"("A" ASC, "B" ASC);

-- CreateIndex
CREATE INDEX "_ShiftAreas_B_index" ON "_ShiftAreas"("B" ASC);

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bonus" ADD CONSTRAINT "Bonus_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Checklist" ADD CONSTRAINT "Checklist_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistCompletion" ADD CONSTRAINT "ChecklistCompletion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ChecklistItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "Checklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCalendarDay" ADD CONSTRAINT "CustomerCalendarDay_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNotification" ADD CONSTRAINT "CustomerNotification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerOrder" ADD CONSTRAINT "CustomerOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerOrderItem" ADD CONSTRAINT "CustomerOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CustomerOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerOrderItem" ADD CONSTRAINT "CustomerOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProduct" ADD CONSTRAINT "CustomerProduct_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProduct" ADD CONSTRAINT "CustomerProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyNote" ADD CONSTRAINT "DailyNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyNote" ADD CONSTRAINT "DailyNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deduction" ADD CONSTRAINT "Deduction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryEntry" ADD CONSTRAINT "DeliveryEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryEntry" ADD CONSTRAINT "DeliveryEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryEntry" ADD CONSTRAINT "DeliveryEntry_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyBudget" ADD CONSTRAINT "MonthlyBudget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteFollowup" ADD CONSTRAINT "NoteFollowup_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "DailyNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcPurchase" ADD CONSTRAINT "OtcPurchase_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcPurchase" ADD CONSTRAINT "OtcPurchase_vendorBillId_fkey" FOREIGN KEY ("vendorBillId") REFERENCES "VendorBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcPurchase" ADD CONSTRAINT "OtcPurchase_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcPurchaseLine" ADD CONSTRAINT "OtcPurchaseLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcPurchaseLine" ADD CONSTRAINT "OtcPurchaseLine_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "OtcPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcSale" ADD CONSTRAINT "OtcSale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcSale" ADD CONSTRAINT "OtcSale_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcSale" ADD CONSTRAINT "OtcSale_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcSale" ADD CONSTRAINT "OtcSale_vendorReceivableId_fkey" FOREIGN KEY ("vendorReceivableId") REFERENCES "VendorReceivable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcSaleLine" ADD CONSTRAINT "OtcSaleLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtcSaleLine" ADD CONSTRAINT "OtcSaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "OtcSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "SampleLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProof" ADD CONSTRAINT "PaymentProof_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionLog" ADD CONSTRAINT "ProductionLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionLog" ADD CONSTRAINT "ProductionLog_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryVisit" ADD CONSTRAINT "RecoveryVisit_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "RecoveryCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetailDispatch" ADD CONSTRAINT "RetailDispatch_farmDispatchId_fkey" FOREIGN KEY ("farmDispatchId") REFERENCES "FarmDispatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetailDispatch" ADD CONSTRAINT "RetailDispatch_vanDispatchId_fkey" FOREIGN KEY ("vanDispatchId") REFERENCES "VanDispatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rider" ADD CONSTRAINT "Rider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderExtraItem" ADD CONSTRAINT "RiderExtraItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderExtraItem" ADD CONSTRAINT "RiderExtraItem_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderExtraItem" ADD CONSTRAINT "RiderExtraItem_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteStopItem" ADD CONSTRAINT "RouteStopItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteStopItem" ADD CONSTRAINT "RouteStopItem_routeStopId_fkey" FOREIGN KEY ("routeStopId") REFERENCES "RouteStop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryPayment" ADD CONSTRAINT "SalaryPayment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SampleFollowup" ADD CONSTRAINT "SampleFollowup_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "SampleLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SampleItem" ADD CONSTRAINT "SampleItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SampleItem" ADD CONSTRAINT "SampleItem_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "SampleLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SampleLead" ADD CONSTRAINT "SampleLead_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SampleLead" ADD CONSTRAINT "SampleLead_convertedCustomerId_fkey" FOREIGN KEY ("convertedCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SampleLead" ADD CONSTRAINT "SampleLead_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFollowup" ADD CONSTRAINT "TaskFollowup_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanDispatch" ADD CONSTRAINT "VanDispatch_farmDispatchId_fkey" FOREIGN KEY ("farmDispatchId") REFERENCES "FarmDispatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorReceivable" ADD CONSTRAINT "VendorReceivable_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ShiftAreas" ADD CONSTRAINT "_ShiftAreas_A_fkey" FOREIGN KEY ("A") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ShiftAreas" ADD CONSTRAINT "_ShiftAreas_B_fkey" FOREIGN KEY ("B") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

