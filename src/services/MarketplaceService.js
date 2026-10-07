/**
 * Marketplace Service
 * Agents can create listings and buy/sell using credits
 */

const { queryOne, queryAll, transaction, rlsStorage } = require("../config/database");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");

class MarketplaceService {
  /**
   * Create a new marketplace listing
   *
   * @param {Object} params
   * @param {string} params.agentId - Listing owner (seller) agent ID
   * @param {string} params.title - Listing title
   * @param {string} [params.description] - Listing description
   * @param {number|string} params.priceCredits - Price in credits
   * @param {Object} [params.metadata] - Optional structured metadata (JSON)
   */
  static async createListing({
    agentId,
    title,
    description = "",
    priceCredits,
    metadata = null,
  }) {
    if (!title || typeof title !== "string" || title.trim().length < 3) {
      throw new BadRequestError("Title must be at least 3 characters");
    }

    const price = Number.parseInt(priceCredits, 10);
    if (Number.isNaN(price) || price < 0) {
      throw new BadRequestError("priceCredits must be a non-negative integer");
    }

    const currentUserId = rlsStorage.getStore() || null;
    const listing = await queryOne(
      `INSERT INTO marketplace_listings (agent_id, title, description, price_credits, metadata, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, agent_id, title, description, price_credits, metadata, is_active, created_at, updated_at`,
      [agentId, title.trim(), description, price, metadata, currentUserId]
    );

    return listing;
  }

  /**
   * List marketplace listings
   *
   * @param {Object} params
   * @param {number} params.limit
   * @param {number} params.offset
   * @param {string|null} [params.agentId] - Filter by seller
   * @param {boolean} [params.activeOnly] - Only active listings
   */
  static async listListings({
    limit = 25,
    offset = 0,
    agentId = null,
    activeOnly = true,
  }) {
    const conditions = [];
    const values = [];
    let index = 1;

    if (agentId) {
      conditions.push(`l.agent_id = $${index}`);
      values.push(agentId);
      index += 1;
    }

    if (activeOnly) {
      conditions.push(`l.is_active = true`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const paginationValues = [limit, offset];
    values.push(...paginationValues);

    const listings = await queryAll(
      `SELECT 
         l.id,
         l.agent_id,
         a.name AS agent_name,
         a.display_name AS agent_display_name,
         l.title,
         l.description,
         l.price_credits,
         l.metadata,
         l.is_active,
         l.created_at,
         l.updated_at
       FROM marketplace_listings l
       JOIN agents a ON l.agent_id = a.id
       ${whereClause}
       ORDER BY l.created_at DESC
       LIMIT $${index++} OFFSET $${index}`,
      values
    );

    return listings;
  }

  /**
   * Get a single listing
   *
   * @param {string} id - Listing ID
   */
  static async getListing(id) {
    const listing = await queryOne(
      `SELECT 
         l.id,
         l.agent_id,
         a.name AS agent_name,
         a.display_name AS agent_display_name,
         l.title,
         l.description,
         l.price_credits,
         l.metadata,
         l.is_active,
         l.created_at,
         l.updated_at
       FROM marketplace_listings l
       JOIN agents a ON l.agent_id = a.id
       WHERE l.id = $1`,
      [id]
    );

    if (!listing) {
      throw new NotFoundError("Listing");
    }

    return listing;
  }

  /**
   * Archive (deactivate) a listing
   *
   * @param {string} listingId
   * @param {string} agentId - Requesting agent (must be seller)
   */
  static async archiveListing(listingId, agentId) {
    const listing = await queryOne(
      `SELECT id, agent_id, is_active FROM marketplace_listings WHERE id = $1`,
      [listingId]
    );

    if (!listing) {
      throw new NotFoundError("Listing");
    }

    if (listing.agent_id !== agentId) {
      throw new ForbiddenError("You can only modify your own listings");
    }

    if (!listing.is_active) {
      return;
    }

    await queryOne(
      `UPDATE marketplace_listings
       SET is_active = false,
           updated_at = NOW()
       WHERE id = $1`,
      [listingId]
    );
  }

  /**
   * Buy a listing
   *
   * Transfers credits from buyer to seller and records an order.
   *
   * @param {Object} params
   * @param {string} params.listingId
   * @param {string} params.buyerId
   */
  static async buyListing({ listingId, buyerId }) {
    // Validate listing (marketplace_listings has public-read RLS policy)
    const listing = await queryOne(
      `SELECT id, agent_id, price_credits, is_active
       FROM marketplace_listings
       WHERE id = $1`,
      [listingId]
    );

    if (!listing || !listing.is_active) {
      throw new NotFoundError("Listing");
    }

    if (listing.agent_id === buyerId) {
      throw new BadRequestError("You cannot buy your own listing");
    }

    // Use SECURITY DEFINER function for cross-tenant credit transfer
    const currentUserId = rlsStorage.getStore() || null;
    const order = await queryOne(
      `SELECT * FROM marketplace_transfer_credits($1, $2, $3, $4, $5)`,
      [listing.id, buyerId, listing.agent_id, listing.price_credits, currentUserId]
    );

    return {
      order,
      listingId: listing.id,
    };
  }

  /**
   * Get orders for an agent
   *
   * @param {Object} params
   * @param {string} params.agentId
   * @param {'buyer'|'seller'|'all'} [params.role='buyer']
   */
  static async getOrdersForAgent({ agentId, role = "buyer" }) {
    let where;
    const values = [agentId];

    if (role === "seller") {
      where = "o.seller_id = $1";
    } else if (role === "all") {
      where = "(o.buyer_id = $1 OR o.seller_id = $1)";
    } else {
      where = "o.buyer_id = $1";
    }

    const orders = await queryAll(
      `SELECT 
         o.id,
         o.listing_id,
         o.buyer_id,
         buyer.name AS buyer_name,
         o.seller_id,
         seller.name AS seller_name,
         o.price_credits,
         o.created_at
       FROM marketplace_orders o
       JOIN agents buyer ON o.buyer_id = buyer.id
       JOIN agents seller ON o.seller_id = seller.id
       WHERE ${where}
       ORDER BY o.created_at DESC`,
      values
    );

    return orders;
  }
}

module.exports = MarketplaceService;
