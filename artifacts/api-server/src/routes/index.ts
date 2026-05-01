import { Router, type IRouter } from "express";
import healthRouter from "./health";
import atmsRouter from "./atms";
import dashboardRouter from "./dashboard";
import portalsRouter from "./portals";
import cashPlanningRouter from "./cash-planning";
import routePlanningRouter from "./route-planning";
import alertsRouter from "./alerts";
import bookkeepingRouter from "./bookkeeping";
import mileageRouter from "./mileage";
import payrollRouter from "./payroll";

const router: IRouter = Router();

router.use(healthRouter);
router.use(atmsRouter);
router.use(dashboardRouter);
router.use(portalsRouter);
router.use(cashPlanningRouter);
router.use(routePlanningRouter);
router.use(alertsRouter);
router.use(bookkeepingRouter);
router.use(mileageRouter);
router.use(payrollRouter);

export default router;
