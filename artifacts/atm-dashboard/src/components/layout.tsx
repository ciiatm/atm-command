import { useState } from "react";
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
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/atms", label: "ATM Fleet", icon: MapPin },
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
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex flex-col min-h-screen w-full bg-background">
      {/* ── Top navigation bar ── */}
      <header className="h-14 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="flex h-full items-center px-4 gap-6">
          {/* Logo */}
          <Link href="/">
            <div className="flex items-center gap-2 flex-shrink-0 cursor-pointer">
              <Banknote className="w-5 h-5 text-primary" />
              <span className="font-bold text-base tracking-tight">ATM Command</span>
            </div>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1 flex-1">
            {navItems.map((item) => {
              const isActive =
                location === item.href ||
                (item.href !== "/" && location.startsWith(item.href));
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                    )}
                  >
                    <item.icon className="w-3.5 h-3.5" />
                    {item.label}
                  </div>
                </Link>
              );
            })}
          </nav>

          {/* Mobile hamburger */}
          <div className="md:hidden ml-auto">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setMobileOpen(o => !o)}
            >
              {mobileOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {/* Mobile dropdown */}
        {mobileOpen && (
          <div className="md:hidden border-t border-border bg-background shadow-lg px-3 py-2 space-y-0.5">
            {navItems.map((item) => {
              const isActive =
                location === item.href ||
                (item.href !== "/" && location.startsWith(item.href));
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                    )}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.label}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </header>

      {/* ── Page content ── */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-screen-2xl mx-auto p-4 md:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
