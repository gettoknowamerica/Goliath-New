import { db, insertLead, seedDatabase, type Lead } from "~/db";

export const businessTypes = [
  { id: "real-estate", label: "Real Estate", description: "Fairfield County CT seller leads for real estate agents and brokers" },
  { id: "cleaning-services", label: "Cleaning Services", description: "Local cleaning companies and prospects" },
  { id: "fitness-gyms", label: "Fitness & Gyms", description: "Fitness studios, gyms, and wellness businesses" },
  { id: "restaurants-cafes", label: "Restaurants & Cafés", description: "Restaurants, cafés, and hospitality prospects" },
  { id: "marketing-agencies", label: "Marketing Agencies", description: "Marketing and creative agencies" },
  { id: "landscaping", label: "Landscaping", description: "Landscaping and outdoor service businesses" },
  { id: "hair-beauty", label: "Hair & Beauty Salons", description: "Salons and beauty service businesses" },
  { id: "it-services", label: "IT Services", description: "Technology and IT service providers" },
];

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
export function body(request: Request) { return request.json() as Promise<Record<string, unknown>>; }
export function generate(type: string, count: number) {
  seedDatabase();
  const available = db.query<Lead>("SELECT * FROM leads WHERE business_type = ? ORDER BY RANDOM()").all(type);
  if (!businessTypes.some((item) => item.id === type)) throw new Error("Unknown business type");
  return available.slice(0, count).map((lead) => {
    const { id: _id, created_at: _createdAt, ...source } = lead;
    return insertLead(source);
  });
}
