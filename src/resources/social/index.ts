/** The `social` namespace: direct messages, relationships and group chats, reachable as `oms.social`. */

import { Resource } from "../../http";
import { GroupChatsNamespace } from "./groupChats";
import { DirectMessagesNamespace } from "./messages";
import { RelationshipsNamespace } from "./relationships";

export * from "./groupChats";
export * from "./messages";
export * from "./relationships";
export * from "./types";

/** The `social` namespace, reachable as `oms.social`. */
export class SocialNamespace extends Resource {
  /** One-to-one messages. */
  readonly messages: DirectMessagesNamespace;
  /** Friendships and blocks. */
  readonly relationships: RelationshipsNamespace;
  /** Many-to-many chats, their roster and their messages. */
  readonly groupChats: GroupChatsNamespace;

  constructor(http: ConstructorParameters<typeof Resource>[0]) {
    super(http);
    this.messages = new DirectMessagesNamespace(http);
    this.relationships = new RelationshipsNamespace(http);
    this.groupChats = new GroupChatsNamespace(http);
  }
}
