import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  MapPin,
  Banknote,
  Route as RouteIcon,
  AlertCircle,
  ServerCog,
  BookOpen,
  Car,
  Users,
  Receipt,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/atms", label: "ATM Fleet", icon: MapPin },
  { href: "/transactions", label: "Transactions", icon: Receipt },
  { href: "/cash-planning", label: "Cash Planning", icon: Banknote },
  { href: "/routes", label: "Routes", icon: RouteIcon },
  { href: "/alerts", label: "Alerts", icon: AlertCircle },
  { href: "/portals", label: "Portals", icon: ServerCog },
  { href: "/bookkeeping", label: "Bookkeeping", icon: BookOpen },
  { href: "/mileage", label: "Mileage", icon: Car },
  { href: "/payroll", label: "Payroll", icon: Users },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="w-64 border-r border-sidebar-border bg-sidebar text-sidebar-foreground hidden md:flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border">
          <Banknote className="w-6 h-6 text-primary mr-2" />
          <h1 className="font-bold text-lg tracking-tight">ATM Command</h1>
        </div>
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center px-3 py-2 rounded-md transition-colors cursor-pointer text-sm font-medium",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                  )}
                >
                  <item.icon className="w-4 h-4 mr-3" />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
